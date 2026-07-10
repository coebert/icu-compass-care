"""
End-to-end test: the exported handover PDF's "Key microbiology" column shows
the NEWEST microbiology result per specimen type (and not older, superseded
entries).

The handover sheet renders one line per specimen type in the "Key microbiology"
column, each showing that specimen type's newest finding by result_at
(see microbiology() / latestMicrobiologyPerSpecimen in src/lib/handover-pdf.ts).

This test seeds a patient with two results per specimen type — inserted OUT OF
ORDER so a naive "last saved wins" implementation would surface the wrong one —
then drives the real UI export and inspects the PDF text:

  1. Restore a clinician session and open /patients.
  2. Preview PDF -> Download PDF, capturing the actual download.
  3. Extract the PDF text (pdftotext) and assert it contains, per specimen type:
       - the newest finding
       - NOT the superseded older finding
     plus the specimen-type labels themselves.

Throwaway clinician user + patient (+microbiology) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-newest.e2e.py
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

MARKER = f"E2EPDFMICRO{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.B.O."

SUFFIX = str(int(time.time()))[-6:]
# Per specimen type: (old finding, new finding). Old is inserted AFTER new.
# Short single-token findings so they never wrap inside the narrow column.
CASES = {
    "Blood culture": (f"BCOLD{SUFFIX}", f"BCNEW{SUFFIX}"),
    "Respiratory (sputum / BAL)": (f"RSOLD{SUFFIX}", f"RSNEW{SUFFIX}"),
    "Urine": (f"UROLD{SUFFIX}", f"URNEW{SUFFIX}"),
}

now = datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat()


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
            "age": 58,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_microbiology(patient_id, specimen_type, findings, result_at):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "specimen_type": specimen_type,
            "findings": findings,
            "result_at": result_at,
        },
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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
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
    # Collapse whitespace so wrapped table cells don't hide our single-token markers.
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # Insert OUT OF ORDER: the NEWER result first, then the OLDER one.
        for specimen, (old, new) in CASES.items():
            add_microbiology(patient_id, specimen, new, iso(now - timedelta(hours=1)))
            add_microbiology(patient_id, specimen, old, iso(now - timedelta(days=4)))

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
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # Make sure our seeded patient is on the board before exporting.
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dialog = page.get_by_role("dialog")
            download_btn = dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed = extract_pdf_text(pdf_path)

        # ---- Specimen-type labels present ----
        for specimen in ("Blood culture", "Urine"):
            assert specimen in raw_text, (
                f"handover PDF missing '{specimen}' in the Key microbiology column"
            )

        # ---- Newest finding per specimen present; older one absent ----
        for specimen, (old, new) in CASES.items():
            assert new in packed, (
                f"{specimen}: newest finding '{new}' missing from handover PDF"
            )
            assert old not in packed, (
                f"{specimen}: superseded older finding '{old}' leaked into handover "
                "PDF — newest-per-specimen selection is wrong"
            )

        # Cleanup the artifact.
        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: handover PDF shows newest microbiology result per specimen type")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
