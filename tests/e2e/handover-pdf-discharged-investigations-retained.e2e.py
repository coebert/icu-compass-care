"""
End-to-end test: exporting the handover PDF for a DISCHARGED ICU patient still
renders the discharge destination, the "Discharged" status, AND all saved
investigations (Bloods / CXR / CT chest) correctly.

This combines two retention guarantees in one export:
  - the discharged record is retained in the archived sheet with "Discharged"
    and "To <destination>" (location() in src/lib/handover-pdf.ts), and
  - every key investigation category the patient had saved still renders its
    newest findings in the "Most recent investigations" column
    (investigations() in src/lib/handover-pdf.ts) — discharge does not wipe or
    hide the clinical investigation history.

Discharged patients live in the archived list, so the export is taken with
"Archive" toggled on.

Steps:
  1. Seed one ICU patient already at status=discharged with a discharge date and
     destination.
  2. Seed one saved investigation per key category (Bloods, CXR, CT chest).
  3. Sign in, go to /patients, toggle Archive, export + download the PDF.
  4. Assert the PDF shows the patient, "Discharged", "To <destination>", and
     each saved investigation's findings.

Throwaway clinician user + patient + investigations are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-discharged-investigations-retained.e2e.py
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

MARKER = f"E2EDISCHINV{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"DINV.{str(int(time.time()))[-4:]}"
DEST = f"Radnor Ward {MARKER}"

NOW = datetime.now(timezone.utc)
DISCHARGE_DATE = (NOW.date() - timedelta(days=2)).isoformat()
ADMISSION_DATE = (NOW.date() - timedelta(days=9)).isoformat()
RESULT_AT = (NOW - timedelta(hours=6)).replace(microsecond=0)

BLOODS = f"Bloods Hb 98 CRP 42 {MARKER}"
CXR = f"CXR bibasal consolidation {MARKER}"
CT = f"CT chest no PE {MARKER}"

INVESTIGATIONS = [
    {"category": "Bloods", "findings": BLOODS, "result_at": RESULT_AT.isoformat()},
    {"category": "CXR", "findings": CXR, "result_at": RESULT_AT.isoformat()},
    {"category": "CT chest", "findings": CT, "result_at": RESULT_AT.isoformat()},
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


def create_discharged_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "6",
            "status": "discharged",
            "admission_date": ADMISSION_DATE,
            "discharge_date": DISCHARGE_DATE,
            "discharge_destination": DEST,
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


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_destination",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


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
        patient_id = create_discharged_patient()
        seed_investigations(patient_id)

        row = read_patient(patient_id)
        assert row["status"] == "discharged", f"seed status wrong: {row['status']!r}"
        assert row["discharge_destination"] == DEST

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

            # Discharged records live in the archive view.
            page.get_by_role("button", name="Archive").click()
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

        # Discharge status + destination retained.
        assert packed(PATIENT_NAME) in packed_text, "discharged patient missing from PDF"
        assert "Discharged" in raw_text, "'Discharged' status not rendered in PDF"
        assert packed(f"To {DEST}") in packed_text, (
            f"discharge destination not rendered as 'To {DEST}' in PDF"
        )

        # All saved investigations still render.
        for label, findings in (("Bloods", BLOODS), ("CXR", CXR), ("CT chest", CT)):
            assert packed(findings) in packed_text, (
                f"{label} investigation findings missing from discharged PDF: {findings!r}"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: discharged ICU patient's handover PDF retains discharge "
            "destination, 'Discharged' status, and all saved investigations "
            "(Bloods / CXR / CT chest)"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
