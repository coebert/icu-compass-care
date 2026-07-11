"""
End-to-end test: a signed-in CLINICAL user records a patient's Next of kin
(NoK) details plus the "Last updated / spoken to" date/time through the real
Edit-patient form, and those values appear in the patient handover view.

The NoK block lives in src/components/PatientForm.tsx:
  - Name / Relationship / Contact details
  - "Last updated / spoken to" (DateTimePicker) -> nok_last_updated
  - "Updated by (staff name)"                    -> nok_last_updated_by

The handover sheet renders these in its TEP/DNACPR/NoK column via flags() in
src/lib/handover-columns.ts:
    NOK: {name} ({relationship}) {contact} [Spoken to {fmtDateTime(nok_last_updated)} by {nok_last_updated_by}]
surfaced on the printable handover preview
(src/components/HandoverPreviewModal.tsx via the Patient board "Preview PDF").

Steps:
  1. Seed an admitted patient (admin API) with NO NoK details, but with the
     critical fields required for handover export (name / hospital number /
     location / current admission).
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Fill NoK name / relationship / contact, set today's "Last updated / spoken
     to" date + time, and the updated-by staff name; Save.
  4. Confirm the database stored the NoK fields (incl. nok_last_updated).
  5. Back on the Patient board, filter to this patient, open Preview PDF,
     download it, and assert the exported handover shows the NoK name,
     relationship, contact, updated-by and the "Spoken to" date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/clinical-user-records-nok-appears-in-handover.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
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

MARKER = f"E2ENOKHV{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"NKH.{str(int(time.time()))[-4:]}"
HOSPITAL_NUMBER = f"MRN{str(int(time.time()))[-6:]}"

NOK_NAME = f"Jane Relative {MARKER}"
NOK_REL = "Daughter"
NOK_CONTACT = f"07700 900{int(time.time()) % 1000:03d}"
NOK_UPDATED_BY = f"Dr Staff {MARKER}"
SPOKEN_TIME = "14:30"


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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "11",
            "status": "admitted",
            "weight_kg": 74,
            "hospital_number": HOSPITAL_NUMBER,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_nok(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=nok_name,nok_relationship,nok_contact,nok_last_updated,nok_last_updated_by",
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


def text_input(scope, label):
    return scope.get_by_text(label, exact=True).locator("xpath=following-sibling::input")


def fill_spoken_to(dialog, spoken_day):
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(spoken_day), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(SPOKEN_TIME)


def packed(s):
    return "".join(s.split())


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
        session = sign_in(email)
        now = datetime.now(timezone.utc)
        spoken_day = now.day
        expected_uk_date = now.strftime("%d/%m/%Y")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
                timezone_id="UTC",
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 1. Record NoK details via the Edit form ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=15000)
            dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()
            text_input(dialog, "Name").fill(NOK_NAME)
            text_input(dialog, "Relationship").fill(NOK_REL)
            text_input(dialog, "Contact details").fill(NOK_CONTACT)
            fill_spoken_to(dialog, spoken_day)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY)
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            # ---- 2. Database persistence ----
            row = read_nok(patient_id)
            assert row["nok_name"] == NOK_NAME, f"nok_name: {row['nok_name']!r}"
            assert row["nok_relationship"] == NOK_REL, (
                f"nok_relationship: {row['nok_relationship']!r}"
            )
            assert row["nok_contact"] == NOK_CONTACT, (
                f"nok_contact: {row['nok_contact']!r}"
            )
            assert row["nok_last_updated_by"] == NOK_UPDATED_BY, (
                f"nok_last_updated_by: {row['nok_last_updated_by']!r}"
            )
            assert row["nok_last_updated"], "nok_last_updated (spoken date/time) not stored"

            # ---- 3. Handover view (PDF) shows the NoK details ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            # Filter the board to just this patient so the export validates and
            # renders only our record (the shared board may hold others).
            page.get_by_placeholder("Search initials or hospital no.…").fill(
                HOSPITAL_NUMBER
            )
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=10000
            )

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
        assert packed(PATIENT_NAME) in packed_text, (
            "patient missing from PDF (blank/failed export?)"
        )

        # The NoK line: name (relationship) contact [Spoken to <dt> by <by>].
        for label, value in (
            ("NoK name", NOK_NAME),
            ("NoK relationship", NOK_REL),
            ("NoK contact", NOK_CONTACT),
            ("updated-by staff", NOK_UPDATED_BY),
            ("spoken-to date", expected_uk_date),
        ):
            assert packed(value) in packed_text, (
                f"{label} missing from handover view: {value!r}"
            )

        # The "Spoken to" annotation must sit alongside the NoK name.
        nok_pos = packed_text.find(packed(NOK_NAME))
        cell = packed_text[nok_pos: nok_pos + 320]
        assert packed("Spokento") in cell, (
            f"'Spoken to' annotation not rendered near NoK name; cell={cell!r}"
        )
        assert packed(expected_uk_date) in cell, (
            f"spoken-to date not rendered near NoK name; cell={cell!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: clinician recorded NoK details + last-spoken date/time; the "
            "handover view shows the NoK name, relationship, contact, updated-by "
            "and spoken-to date"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
