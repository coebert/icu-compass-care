"""
End-to-end test: an authorized clinician UPDATES a DIED patient's notes through
the Edit dialog, downloads the handover PDF from the detail page, and the
downloaded PDF reflects the UPDATED data (not the pre-edit values).

Why this shape:
  - Died records are retained and remain editable (per the lifecycle rules in
    src/lib/patients.functions.ts). This proves the genuine UI edit path
    (PatientForm -> updatePatient) flows through to the handover sheet built by
    downloadHandover (src/lib/handover-pdf.ts / handover-columns.ts).
  - Editing then exporting is the real clinical workflow: correct the notes on a
    died patient, then generate the handover. The PDF must show the fresh values.

Steps:
  1. Seed a died patient with ORIGINAL notes (PMH / current admission /
     management) via the admin REST API.
  2. Sign in as a throwaway clinician, open /patients/{id}, open Edit, and
     replace the three free-text notes with UPDATED tokens; save.
  3. Confirm the edit persisted to the database (source of truth).
  4. Click "Handover PDF", capture the download, extract text, and assert it
     contains the UPDATED notes, the saved name/MRN/ward and the "Died" status,
     and does NOT contain any of the ORIGINAL note tokens.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/died-patient-edit-notes-pdf-matches.e2e.py
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

MARKER = f"E2EDNEDIT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = "E.N. Died"  # <= 10 chars (patient-schema full_name limit)
MRN = f"MRN{MARKER}"
WARD = "Critical Care"
BED = "41"

PMH_OLD = f"PMHold-{MARKER}"
ADMISSION_OLD = f"Admold-{MARKER}"
MANAGEMENT_OLD = f"Mgmtold-{MARKER}"

PMH_NEW = f"PMHnew-{MARKER}"
ADMISSION_NEW = f"Admnew-{MARKER}"
MANAGEMENT_NEW = f"Mgmtnew-{MARKER}"

ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=6)).isoformat()
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
            "age": 77,
            "location_type": "icu",
            "ward": WARD,
            "bed": BED,
            "status": "died",
            "admission_date": ADMISSION_DATE,
            "date_of_death": DEATH_DATE,
            "past_medical_history": PMH_OLD,
            "current_admission": ADMISSION_OLD,
            "current_management": MANAGEMENT_OLD,
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


def edit_note(dialog, label, value):
    ta = dialog.locator(
        f"xpath=.//label[normalize-space()='{label}']/following::textarea[1]"
    )
    expect(ta).to_be_visible(timeout=10000)
    ta.fill(value)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_died_patient()
        assert read_patient(patient_id)["status"] == "died"
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
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 1. Update the died patient's notes via the Edit dialog ----
            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)
            edit_note(dialog, "Past medical history", PMH_NEW)
            edit_note(dialog, "Current admission", ADMISSION_NEW)
            edit_note(dialog, "Current management", MANAGEMENT_NEW)
            dialog.get_by_role("button", name="Save changes").click()
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1500)

            # ---- 2. The edit persisted to the database ----
            saved = read_patient(patient_id)
            assert saved["status"] == "died", f"status changed: {saved['status']!r}"
            assert saved["past_medical_history"] == PMH_NEW, "PMH not updated in DB"
            assert saved["current_admission"] == ADMISSION_NEW, "admission not updated in DB"
            assert saved["current_management"] == MANAGEMENT_NEW, "management not updated in DB"

            # ---- 3. Download the handover PDF ----
            dl_btn = page.get_by_role("button", name="Handover PDF")
            expect(dl_btn).to_be_enabled(timeout=10000)
            with page.expect_download(timeout=30000) as dl_info:
                dl_btn.click()
            dl = dl_info.value
            pdf_path = DOWNLOADS / f"died_edit_handover_{MARKER}.pdf"
            dl.save_as(str(pdf_path))
            assert pdf_path.stat().st_size > 0, "downloaded PDF is empty"
            page.screenshot(path=str(SCREENSHOTS / "died_edit_pdf_after_download.png"))
            browser.close()

        raw = extract_pdf_text(pdf_path)
        text = packed(raw)

        # ---- 4. PDF reflects the UPDATED data ----
        must_contain = {
            "patient name": PATIENT_NAME,
            "MRN": saved["hospital_number"],
            "ward": saved["ward"],
            "Died status label": "Died",
            "updated PMH": PMH_NEW,
            "updated admission": ADMISSION_NEW,
            "updated management": MANAGEMENT_NEW,
        }
        for label, value in must_contain.items():
            assert packed(value) in text, (
                f"{label} ({value!r}) missing from downloaded PDF"
            )

        # The pre-edit note tokens must NOT survive into the exported PDF.
        for label, value in {
            "old PMH": PMH_OLD,
            "old admission": ADMISSION_OLD,
            "old management": MANAGEMENT_OLD,
        }.items():
            assert packed(value) not in text, (
                f"stale {label} ({value!r}) still present in downloaded PDF"
            )

        assert "Discharged" not in raw, "died PDF wrongly shows 'Discharged'"

        print(
            "PASS: died patient's notes edited via UI, persisted to DB, and the "
            "downloaded handover PDF shows the updated notes with no stale values"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
