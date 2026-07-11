"""
End-to-end test: a signed-in CLINICAL user (clinician role) CAN both VIEW and
EDIT the DNACPR (do-not-attempt-CPR) decision and the treatment-escalation-plan
(TEP) fields on a patient record.

This is the positive counterpart to
`non-clinical-user-cannot-view-or-edit-dnacpr-escalation.e2e.py`: where a
non-clinical user is denied, a clinician must be granted full read/write.

The escalation controls live in src/components/PatientForm.tsx:
  - "Treatment escalation plan (TEP) in place"  -> tep_in_place + tep_details
  - "DNACPR — decision not to attempt CPR"      -> dnacpr_decision + dnacpr_date
                                                   + dnacpr_details
They are read back on the patient detail page under the "Escalation & Resus"
tab (src/routes/_authenticated/patients.$patientId.tsx).

Steps:
  1. Seed a patient that ALREADY has DNACPR + TEP recorded (concrete values).
  2. Sign in as a throwaway clinician; open the record.
  3. VIEW: open "Escalation & Resus" and assert the seeded DNACPR + TEP values
     are visible.
  4. EDIT: open the Edit form (existing values must be prefilled), change the
     TEP details and the DNACPR details, Save.
  5. Assert the database now holds the edited values.
  6. Hard-refresh and assert the "Escalation & Resus" tab shows the edited
     values (and no longer shows the originals).

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/clinical-user-can-view-and-edit-dnacpr-escalation.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
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

MARKER = f"E2EVE{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "V.E. Esc"  # <= 10 chars

ORIG_TEP_DETAILS = f"Original ceiling: ward-based only {MARKER}"
ORIG_DNACPR_DETAILS = f"Original DNACPR agreed {MARKER}"
NEW_TEP_DETAILS = f"Updated ceiling: full escalation incl ICU {MARKER}"
NEW_DNACPR_DETAILS = f"Updated DNACPR reviewed with family {MARKER}"


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


def create_patient(dnacpr_date_iso):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 79,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "12",
            "status": "admitted",
            "weight_kg": 80,
            "tep_in_place": True,
            "tep_details": ORIG_TEP_DETAILS,
            "dnacpr_decision": True,
            "dnacpr_date": dnacpr_date_iso,
            "dnacpr_details": ORIG_DNACPR_DETAILS,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details,dnacpr_decision,dnacpr_details,dnacpr_date",
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


def open_escalation_tab(page):
    tab = page.get_by_role("tab", name="Escalation & Resus")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def main():
    user_id = patient_id = None
    try:
        now = datetime.now(timezone.utc)
        dnacpr_iso = now.date().isoformat()
        expected_uk_date = now.strftime("%d/%m/%Y")

        user_id, email = create_user()
        patient_id = create_patient(dnacpr_iso)
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
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

            # ---- 1. VIEW: the clinician can see the seeded DNACPR + TEP ----
            panel = open_escalation_tab(page)
            expect(panel.get_by_text("TEP in place", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(
                panel.get_by_text(ORIG_TEP_DETAILS, exact=False).first
            ).to_be_visible(timeout=10000)
            expect(
                panel.get_by_text("DNACPR decision made", exact=False).first
            ).to_be_visible(timeout=10000)
            expect(
                panel.get_by_text(ORIG_DNACPR_DETAILS, exact=False).first
            ).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "clin_view_dnacpr_before_edit.png"))

            # ---- 2. EDIT: open the form and change the details ----
            page.get_by_role("button", name="Edit").first.click()
            expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(
                timeout=10000
            )
            dialog = page.get_by_role("dialog")

            # Existing values must be prefilled (proves edit access to the fields).
            tep_textarea = dialog.locator(
                "xpath=.//label[normalize-space()='TEP details']/following-sibling::textarea[1]"
            )
            dnacpr_input = dialog.locator(
                "xpath=.//label[normalize-space()='DNACPR details']/following-sibling::input[1]"
            )
            expect(tep_textarea).to_have_value(ORIG_TEP_DETAILS, timeout=10000)
            expect(dnacpr_input).to_have_value(ORIG_DNACPR_DETAILS, timeout=10000)

            tep_textarea.fill(NEW_TEP_DETAILS)
            dnacpr_input.fill(NEW_DNACPR_DETAILS)

            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("heading", name="Edit patient")).to_have_count(
                0, timeout=10000
            )

            # ---- 3. Database now holds the edited values ----
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place should remain true"
            assert row["tep_details"] == NEW_TEP_DETAILS, (
                f"tep_details not updated: {row['tep_details']!r}"
            )
            assert row["dnacpr_decision"] is True, "dnacpr_decision should remain true"
            assert row["dnacpr_details"] == NEW_DNACPR_DETAILS, (
                f"dnacpr_details not updated: {row['dnacpr_details']!r}"
            )

            # ---- 4. Refresh: UI shows the edited values, not the originals ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"

            panel = open_escalation_tab(page)
            expect(
                panel.get_by_text(NEW_TEP_DETAILS, exact=False).first
            ).to_be_visible(timeout=10000)
            expect(
                panel.get_by_text(NEW_DNACPR_DETAILS, exact=False).first
            ).to_be_visible(timeout=10000)
            expect(panel.get_by_text(expected_uk_date, exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(ORIG_TEP_DETAILS, exact=False)).to_have_count(0)
            expect(panel.get_by_text(ORIG_DNACPR_DETAILS, exact=False)).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "clin_view_dnacpr_after_edit.png"))

            browser.close()

        print(
            "PASS: clinician viewed the seeded DNACPR + TEP values, edited them "
            "through the form, and the updates persisted in the database and on "
            "the Escalation & Resus tab after a full refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
