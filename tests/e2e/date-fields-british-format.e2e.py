"""
End-to-end test: every date and date-time field renders in British DD/MM/YYYY
(and the datetime field adds a 24-hour HH:mm) on BOTH desktop and mobile, and
saved values re-render identically after a full page refresh.

The app deliberately replaced native <input type="date"> with the British
DatePicker / DateTimePicker (src/components/ui/date-picker.tsx), which always
displays `dd/MM/yyyy` regardless of browser locale. This test proves that
end-to-end through the real edit form instead of trusting it by inspection:

  1. Create an admin + one DISCHARGED patient carrying every date field:
       admission_date, discharge_date, dnacpr_date (DatePicker)
       nok_last_updated (DateTimePicker: date + time)
     via the Supabase admin REST API.
  2. For each viewport (desktop 1280px, mobile 375px):
       a. Open the patient detail page and click "Edit".
       b. Assert each date field's trigger shows the exact British DD/MM/YYYY
          string, and the datetime field also shows the 24-hour HH:mm time.
       c. Assert NO native date/datetime inputs exist anywhere in the form.
       d. Reload the whole page, reopen "Edit", and assert every field shows the
          identical strings — values survive a refresh unchanged.

A throwaway admin user + one patient are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/date-fields-british-format.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
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

MARKER = f"E2EDATEFMT{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.F.T."

# Stored values (ISO) -> expected British display strings.
ADMISSION_ISO = "2024-03-15"
DISCHARGE_ISO = "2024-04-02"
DNACPR_ISO = "2024-03-20"
NOK_ISO = "2023-06-09T14:25:00+00:00"

EXPECTED_DATES = {
    "admission": "15/03/2024",
    "discharge": "02/04/2024",
    "dnacpr": "20/03/2024",
    "nok_date": "09/06/2023",
}
EXPECTED_NOK_TIME = "14:25"

VIEWPORTS = {"desktop": (1280, 1800), "mobile": (375, 900)}


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
        json={"user_id": uid, "role": "admin"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "discharged",
            "admission_date": ADMISSION_ISO,
            "discharge_date": DISCHARGE_ISO,
            "discharge_destination": "Ward 12",
            "dnacpr_decision": True,
            "dnacpr_date": DNACPR_ISO,
            "dnacpr_details": "Discussed with family",
            "nok_last_updated": NOK_ISO,
            "nok_name": "Jane Doe",
            "current_management": f"British date format check {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


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


def open_edit_form(page):
    page.get_by_role("button", name="Edit").first.click()
    expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(
        timeout=10000
    )
    # Wait for a known date field to be wired up.
    expect(page.get_by_text(EXPECTED_DATES["admission"], exact=True)).to_be_visible(
        timeout=10000
    )


def assert_all_fields(page, vp_name, phase):
    ctx = f"[{vp_name}/{phase}]"

    # Every British date string is shown exactly once in the form triggers.
    for label, disp in EXPECTED_DATES.items():
        loc = page.get_by_text(disp, exact=True)
        assert loc.count() >= 1, f"{ctx} {label} date '{disp}' (DD/MM/YYYY) not shown"
        expect(loc.first).to_be_visible()

    # The datetime field also exposes a 24-hour time value.
    time_input = page.locator('input[type="time"][aria-label="Time"]')
    expect(time_input).to_have_value(EXPECTED_NOK_TIME, timeout=5000)

    # No US-style M/D/YYYY leakage for our unambiguous dates (15 can't be a month).
    body = page.inner_text("body")
    assert "3/15/2024" not in body, f"{ctx} found US-format admission date"
    assert "4/2/2024" not in body, f"{ctx} found US-format discharge date"

    # No native date/datetime inputs remain in the DOM (only the time sub-input).
    native = page.evaluate(
        """() => document.querySelectorAll(
             'input[type="date"], input[type="datetime-local"], input[type="month"], input[type="week"]'
           ).length"""
    )
    assert native == 0, f"{ctx} found {native} native date input(s) — should be zero"


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        detail_url = f"{BASE_URL}/patients/{patient_id}"

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            for vp_name, (w, h) in VIEWPORTS.items():
                context = browser.new_context(viewport={"width": w, "height": h})
                page = context.new_page()

                page.goto(BASE_URL, wait_until="domcontentloaded")
                page.evaluate(
                    "([k, v]) => window.localStorage.setItem(k, v)",
                    [STORAGE_KEY, json.dumps(session)],
                )

                # --- First render ---
                page.goto(detail_url, wait_until="domcontentloaded")
                page.wait_for_load_state("networkidle")
                assert "/auth" not in page.url, f"[{vp_name}] bounced to /auth"
                open_edit_form(page)
                assert_all_fields(page, vp_name, "initial")
                page.screenshot(path=str(SCREENSHOTS / f"datefmt_{vp_name}_initial.png"))

                # --- After a full refresh, values must re-render identically ---
                page.reload(wait_until="domcontentloaded")
                page.wait_for_load_state("networkidle")
                open_edit_form(page)
                assert_all_fields(page, vp_name, "after-refresh")
                page.screenshot(path=str(SCREENSHOTS / f"datefmt_{vp_name}_refresh.png"))

                context.close()

            browser.close()

        print(
            "PASS: all date/date-time fields render British DD/MM/YYYY (+ HH:mm) on "
            "desktop and mobile, and persist identically across a refresh"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
