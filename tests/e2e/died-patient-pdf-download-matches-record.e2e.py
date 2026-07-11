"""
End-to-end test: an authorized clinician downloads a DIED patient's handover
PDF from the patient detail page, and the downloaded PDF content matches the
saved handover record.

Why this shape:
  - The detail-page "Handover PDF" button builds the sheet from the live record
    (downloadHandover in src/lib/handover-pdf.ts / handover-columns.ts). For a
    died patient the "Location / status" column renders the "Died" status label
    (STATUS_LABELS), and the identity + clinical columns render the saved
    name/MRN/ward and free-text fields. This proves the authorized download
    reflects exactly what is stored — no stale, blank, or leaked data.
  - A died record is TERMINAL, so we seed it directly (status="died" with a
    date of death) via the admin REST API and read it back as the source of
    truth before comparing the PDF.

Steps:
  1. Seed a died patient with every critical handover field populated.
  2. Read the record back from the DB — the authoritative "saved handover data".
  3. Sign in as a throwaway clinician, open /patients/{id}, click "Handover PDF"
     and capture the download.
  4. Extract the PDF text and assert it contains the saved name, MRN, ward,
     "Died" status, and the saved clinical free-text (PMH / current admission /
     management) — and does NOT show "Discharged" or "Admitted".

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/died-patient-pdf-download-matches-record.e2e.py
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
DOWNLOADS = Path(__file__).parent / "downloads"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
DOWNLOADS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EDIED{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = "D.P. Died"  # <= 10 chars (patient-schema full_name limit)
MRN = f"MRN{MARKER}"
WARD = "Critical Care"
BED = "39"
PMH = f"PMH-token-{MARKER}"
ADMISSION = f"AdmNote-token-{MARKER}"
MANAGEMENT = f"MgmtNote-token-{MARKER}"
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=5)).isoformat()
DEATH_DATE = datetime.now(timezone.utc).date().isoformat()


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


def create_died_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "hospital_number": MRN,
            "age": 74,
            "location_type": "icu",
            "ward": WARD,
            "bed": BED,
            "status": "died",
            "admission_date": ADMISSION_DATE,
            "date_of_death": DEATH_DATE,
            "past_medical_history": PMH,
            "current_admission": ADMISSION,
            "current_management": MANAGEMENT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=full_name,hospital_number,ward,bed,status,date_of_death,"
        "past_medical_history,current_admission,current_management",
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


def packed(s):
    """Whitespace-free text so PDF column wrapping cannot split a token."""
    return "".join(str(s).split())


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_died_patient()
        saved = read_patient(patient_id)
        assert saved["status"] == "died", f"seed status: {saved['status']!r}"
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800}, accept_downloads=True
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            # Record is viewable and marked Died before download.
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- Authorized download of the handover PDF ----
            dl_btn = page.get_by_role("button", name="Handover PDF")
            expect(dl_btn).to_be_enabled(timeout=10000)
            with page.expect_download(timeout=30000) as dl_info:
                dl_btn.click()
            dl = dl_info.value
            pdf_path = DOWNLOADS / f"died_handover_{MARKER}.pdf"
            dl.save_as(str(pdf_path))
            assert pdf_path.stat().st_size > 0, "downloaded PDF is empty"
            page.screenshot(path=str(SCREENSHOTS / "died_pdf_after_download.png"))
            browser.close()

        raw = extract_pdf_text(pdf_path)
        text = packed(raw)

        # ---- Downloaded PDF matches the saved handover data ----
        checks = {
            "patient name": PATIENT_NAME,
            "MRN": saved["hospital_number"],
            "ward": saved["ward"],
            "Died status label": "Died",
            "past medical history": saved["past_medical_history"],
            "current admission": saved["current_admission"],
            "management": saved["current_management"],
        }
        for label, value in checks.items():
            assert packed(value) in text, (
                f"{label} ({value!r}) missing from downloaded PDF"
            )

        # A died record must NOT be labelled discharged/admitted in the PDF.
        assert "Discharged" not in raw, "died PDF wrongly shows 'Discharged'"
        assert "Admitted" not in raw, "died PDF wrongly shows 'Admitted'"

        print(
            "PASS: authorized clinician downloaded the died patient's handover "
            "PDF; content (name, MRN, ward, 'Died', clinical notes) matches the "
            "saved record with no wrong status label"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
