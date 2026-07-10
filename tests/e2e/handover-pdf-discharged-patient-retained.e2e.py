"""
End-to-end test: exporting the handover PDF for an ALREADY-discharged patient
still includes that record, with the correct discharged status and discharge
destination rendered.

Where handover-pdf-discharge-destination.e2e.py exercises the *act* of
discharging through the Status tab, this test focuses on RETENTION: a patient
who was discharged (with a destination and discharge date) must not disappear
from the handover sheet — the archived export must still carry them with
"Discharged" and "To <destination>".

The handover sheet's "Location / status" column is built by location() in
src/lib/handover-pdf.ts. For a discharged patient it renders:

  <ward · Bed n>
  Discharged
  To <discharge_destination>
  Adm <dd/mm/yyyy>

Discharged patients live in the archived list, so the export is taken with
"Archive" toggled on.

Steps:
  1. Seed one patient already at status=discharged with a discharge date and
     discharge destination (the retained record).
  2. Sign in, go to /patients, toggle Archive so discharged records show.
  3. Export + download the handover PDF.
  4. Assert the PDF shows the patient name, "Discharged", and
     "To <destination>".

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-discharged-patient-retained.e2e.py
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

MARKER = f"E2EPDFDRET{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"D.RET.{str(int(time.time()))[-4:]}"
DEST = f"Community hospital {MARKER}"

# Discharged a few days ago so the record is genuinely a retained archive entry.
DISCHARGE_DATE = (datetime.now(timezone.utc).date() - timedelta(days=3)).isoformat()
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=8)).isoformat()


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
    """Seed a patient already discharged, with destination + dates (retained)."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "4",
            "status": "discharged",
            "admission_date": ADMISSION_DATE,
            "discharge_date": DISCHARGE_DATE,
            "discharge_destination": DEST,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination",
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

        # Sanity: the seed is genuinely a retained discharged record.
        row = read_patient(patient_id)
        assert row["status"] == "discharged", f"seed status wrong: {row['status']!r}"
        assert row["discharge_destination"] == DEST, (
            f"seed destination wrong: {row['discharge_destination']!r}"
        )

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

        # The discharged record is retained in the export, with status + destination.
        assert packed(PATIENT_NAME) in packed_text, (
            "discharged patient missing from the exported PDF"
        )
        assert "Discharged" in raw_text, "'Discharged' status not rendered in PDF"
        assert packed(f"To {DEST}") in packed_text, (
            f"discharge destination not rendered as 'To {DEST}' in PDF; "
            f"region: {packed_text[packed_text.find('Discharged'):packed_text.find('Discharged')+120]!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: an already-discharged patient is retained in the archived handover "
            "PDF with the correct 'Discharged' status and discharge destination"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
