"""
End-to-end test: next-of-kin details survive discharge and stay editable.

Drives the real ICU handover app in a headless browser as an authenticated
clinician/admin and exercises the full next-of-kin (NOK) lifecycle on a single
patient record:

  1. RECORD      — open a patient, edit it, and fill in the Next of kin block:
     name, relationship, contact, the "Last updated / spoken to" date+time and
     the "Updated by" staff name. Save and confirm the NOK tab shows them.
  2. PERSIST     — edit the same patient again, change the status to
     "Discharged", save, and confirm every NOK field (including the
     last-updated timestamp) is still displayed on the discharged record.
  3. EDITABLE    — reopen the edit form on the now-discharged patient, confirm
     the NOK inputs are pre-populated (still editable), change the contact,
     save, and confirm the update lands.

The patient row and the throwaway admin user are created and removed via the
Supabase admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/nok-persistence.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime
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

MARKER = f"NOK{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

# Uniquely identifiable NOK values for this run.
NOK_NAME = f"{MARKER}-KIN"
NOK_REL = f"{MARKER}-DAUGHTER"
NOK_CONTACT = f"{MARKER}-07700900000"
NOK_UPDATED_BY = f"{MARKER}-NURSE"
NOK_CONTACT_2 = f"{MARKER}-07700900999"  # edited value after discharge
SPOKEN_DAY = 15  # mid-month day, never rendered as an out-of-month duplicate
SPOKEN_TIME = "14:30"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
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
            "full_name": "E2E NOK",
            "age": 61,
            "location_type": "icu",
            "status": "admitted",
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


def cleanup(user_id, patient_id):
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


# ---- form helpers (scoped to the open Edit dialog) --------------------------

def text_input(scope, label):
    """The <input> that follows a Field <label> with exact text `label`."""
    return scope.get_by_text(label, exact=True).locator("xpath=following-sibling::input")


def open_edit(page):
    page.get_by_role("button", name="Edit").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=15000)
    # Scroll the NOK section into view; it is at the bottom of a tall form.
    dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()
    return dialog


def save(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)


def fill_spoken_to(dialog):
    """Pick a date + time in the 'Last updated / spoken to' DateTimePicker."""
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    # react-day-picker popover: click the mid-month day (unique in the grid).
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(SPOKEN_DAY), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(SPOKEN_TIME)


def show_nok_tab(page):
    page.get_by_role("tab", name="Next of kin").click()


def main():
    user_id = None
    patient_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()
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
            assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"

            # ---- 1. RECORD NOK details ----
            dialog = open_edit(page)
            text_input(dialog, "Name").fill(NOK_NAME)
            text_input(dialog, "Relationship").fill(NOK_REL)
            text_input(dialog, "Contact details").fill(NOK_CONTACT)
            fill_spoken_to(dialog)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY)
            save(page, dialog)

            show_nok_tab(page)
            for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            # British date + 24h time from the DateTimePicker.
            expect(page.get_by_text(f"{SPOKEN_DAY:02d}/", exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_text(SPOKEN_TIME, exact=False).first).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "nok_1_recorded.png"))

            # ---- 2. PERSIST after discharge ----
            dialog = open_edit(page)
            dialog.get_by_text("Status", exact=True).locator(
                "xpath=following-sibling::button"
            ).click()
            page.get_by_role("option", name="Discharged").click()
            save(page, dialog)

            # Status is now discharged, yet the NOK details must remain.
            expect(page.get_by_text("Discharged", exact=False).first).to_be_visible(timeout=15000)
            show_nok_tab(page)
            for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            expect(page.get_by_text(SPOKEN_TIME, exact=False).first).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "nok_2_after_discharge.png"))

            # ---- 3. STILL EDITABLE on the discharged record ----
            dialog = open_edit(page)
            # Fields are pre-populated (still editable), proving nothing was wiped.
            expect(text_input(dialog, "Name")).to_have_value(NOK_NAME, timeout=15000)
            expect(text_input(dialog, "Relationship")).to_have_value(NOK_REL)
            expect(text_input(dialog, "Updated by (staff name)")).to_have_value(NOK_UPDATED_BY)
            contact = text_input(dialog, "Contact details")
            expect(contact).to_have_value(NOK_CONTACT)
            contact.fill(NOK_CONTACT_2)
            save(page, dialog)

            show_nok_tab(page)
            expect(page.get_by_text(NOK_CONTACT_2, exact=True)).to_be_visible(timeout=15000)
            assert (
                page.get_by_text(NOK_CONTACT, exact=True).count() == 0
            ), "old contact still shown after edit"
            page.screenshot(path=str(SCREENSHOTS / "nok_3_edited.png"))

            browser.close()

        print(
            "PASS: NOK details recorded, persisted through discharge, and remained editable"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
