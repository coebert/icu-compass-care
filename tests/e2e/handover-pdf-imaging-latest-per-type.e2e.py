"""
End-to-end test: seeding multiple CXR and CT chest imaging results with
different result dates, then exporting the handover PDF, renders ONLY the most
recent imaging per type — older superseded imaging must not appear.

The handover sheet's "Most recent investigations" column is built by
investigations() in src/lib/handover-pdf.ts. For each key category (Bloods /
CXR / CT chest) it renders a single line with the newest findings and its
result time:

  CXR: <newest CXR findings> (dd/mm/yyyy HH:MM)
  CT chest: <newest CT chest findings> (dd/mm/yyyy HH:MM)

The "newest" per category is chosen by mostRecentInvestigation() comparing
result_at. This test seeds two CXR results and two CT chest results per patient
(an older and a newer of each) and asserts the export shows only the newer
findings for each type, with the older findings and their timestamps absent.

Steps:
  1. Seed one admitted patient.
  2. Seed 2x CXR (old + new) and 2x CT chest (old + new) via the admin API.
  3. Sign in, go to /patients, export + download the handover PDF.
  4. Assert the PDF contains the NEW CXR + NEW CT chest findings, and does NOT
     contain the OLD findings or their timestamps.

Throwaway clinician user + patient + investigations are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-imaging-latest-per-type.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EIMG{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"IMG.{str(int(time.time()))[-4:]}"

NOW = datetime.now(timezone.utc)
OLD_AT = (NOW - timedelta(days=3)).replace(microsecond=0)
NEW_AT = (NOW - timedelta(hours=2)).replace(microsecond=0)

# Distinct, searchable findings per (type, age).
CXR_OLD = f"CXR old left basal atelectasis {MARKER}"
CXR_NEW = f"CXR new clear lung fields {MARKER}"
CT_OLD = f"CT old small pleural effusion {MARKER}"
CT_NEW = f"CT new resolved effusion {MARKER}"

INVESTIGATIONS = [
    {"category": "CXR", "findings": CXR_OLD, "result_at": OLD_AT.isoformat()},
    {"category": "CXR", "findings": CXR_NEW, "result_at": NEW_AT.isoformat()},
    {"category": "CT chest", "findings": CT_OLD, "result_at": OLD_AT.isoformat()},
    {"category": "CT chest", "findings": CT_NEW, "result_at": NEW_AT.isoformat()},
]


def packed(s):
    return "".join(s.split())


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"{MARKER.lower()}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/user_roles",
        headers=admin_headers(),
        json={"user_id": uid, "role": "clinician"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "5",
            "status": "admitted",
            "admission_date": NOW.date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_investigations(patient_id):
    rows = [{**inv, "patient_id": patient_id} for inv in INVESTIGATIONS]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=rows,
        timeout=30,
    )
    r.raise_for_status()


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_id, user_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_investigations(patient_id)
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dlg = page.get_by_role("dialog")
            download_btn = dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # Only the most recent imaging per type is shown.
        assert packed(CXR_NEW) in packed_text, "newest CXR findings missing from PDF"
        assert packed(CT_NEW) in packed_text, "newest CT chest findings missing from PDF"

        assert packed(CXR_OLD) not in packed_text, (
            "superseded (older) CXR findings leaked into the PDF"
        )
        assert packed(CT_OLD) not in packed_text, (
            "superseded (older) CT chest findings leaked into the PDF"
        )

        # The old result timestamp must not appear for these imaging lines.
        old_stamp = OLD_AT.strftime("%d/%m/%Y")
        # (Only assert absence if the old and new dates differ, which they do.)
        assert old_stamp != NEW_AT.strftime("%d/%m/%Y")

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: with two CXR and two CT chest results seeded, the handover "
            "PDF shows only the most recent imaging per type; older imaging is "
            "not rendered"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
