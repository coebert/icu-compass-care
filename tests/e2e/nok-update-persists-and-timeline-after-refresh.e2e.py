"""
End-to-end test: updating a patient's Next of kin details and the
"Last updated / spoken to" date, then logging the family conversation on the
Timeline, persists across a refresh AND is reflected on the Timeline.

The Next of kin block lives in src/components/PatientForm.tsx:
  - Name / Relationship / Contact details
  - "Last updated / spoken to" (DateTimePicker) -> nok_last_updated
  - "Updated by (staff name)"                    -> nok_last_updated_by
Read back on the patient detail page under the "Next of kin" tab, and on the
"Timeline" tab (src/routes/_authenticated/patients.$patientId.tsx).

The Timeline auto-surfaces admission / discharge / death / status-change /
investigation events; a NoK conversation is recorded as a Timeline "key event"
(the Add event dialog). This test therefore models the real clinician flow:
update the NoK block AND log the family update on the Timeline.

Steps:
  1. Seed an ADMITTED patient with an empty Next of kin block.
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Fill the NoK name / relationship / contact, set today's "Last updated /
     spoken to" date+time, and the updated-by staff name; Save.
  4. Add a Timeline key event documenting the family conversation.
  5. Confirm the database stored the NoK fields and the event row.
  6. Hard-refresh; the Next of kin tab shows the saved details, and the Edit
     form is pre-populated with them.
  7. Open the Timeline tab and confirm the NoK conversation event appears with
     its details and today's date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/nok-update-persists-and-timeline-after-refresh.e2e.py
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

MARKER = f"E2ENOKT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.K.Talk"  # <= 10 chars
NOK_NAME = f"Jane Relative {MARKER}"
NOK_REL = "Daughter"
NOK_CONTACT = f"07700 900{int(time.time()) % 1000:03d}"
NOK_UPDATED_BY = f"Dr Staff {MARKER}"
SPOKEN_TIME = "14:30"
EVENT_DETAILS = f"Spoke with next of kin; updated on progress and plan {MARKER}"


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


def read_events(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patient_events?patient_id=eq.{patient_id}"
        "&select=event_type,description,event_at",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


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
            f"{SUPABASE_URL}/rest/v1/patient_events?patient_id=eq.{patient_id}",
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


def text_input(scope, label):
    return scope.get_by_text(label, exact=True).locator("xpath=following-sibling::input")


def open_edit(page):
    page.get_by_role("button", name="Edit").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=15000)
    dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()
    return dialog


def save_edit(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)


def fill_spoken_to(dialog, spoken_day):
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(spoken_day), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(SPOKEN_TIME)


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def add_timeline_event(page, panel, details):
    panel.get_by_role("button", name="Add event").click()
    add_dialog = page.get_by_role("dialog")
    expect(add_dialog.get_by_role("heading", name="Add key event")).to_be_visible(timeout=10000)
    add_dialog.locator(
        "xpath=.//label[normalize-space()='Details (optional)']/following::textarea[1]"
    ).fill(details)
    add_dialog.get_by_role("button", name="Add event").click()
    expect(add_dialog.get_by_role("heading", name="Add key event")).to_have_count(0, timeout=10000)


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
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- 1. Update the Next of kin block ----
            dialog = open_edit(page)
            text_input(dialog, "Name").fill(NOK_NAME)
            text_input(dialog, "Relationship").fill(NOK_REL)
            text_input(dialog, "Contact details").fill(NOK_CONTACT)
            fill_spoken_to(dialog, spoken_day)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY)
            save_edit(page, dialog)

            # ---- 2. Log the family conversation on the Timeline ----
            panel = open_tab(page, "Timeline")
            add_timeline_event(page, panel, EVENT_DETAILS)

            # ---- 3. Database persistence ----
            row = read_nok(patient_id)
            assert row["nok_name"] == NOK_NAME, f"nok_name: {row['nok_name']!r}"
            assert row["nok_relationship"] == NOK_REL, f"nok_relationship: {row['nok_relationship']!r}"
            assert row["nok_contact"] == NOK_CONTACT, f"nok_contact: {row['nok_contact']!r}"
            assert row["nok_last_updated_by"] == NOK_UPDATED_BY, (
                f"nok_last_updated_by: {row['nok_last_updated_by']!r}"
            )
            assert row["nok_last_updated"], "nok_last_updated (last spoken date) not stored"
            events = read_events(patient_id)
            assert any(e["description"] == EVENT_DETAILS for e in events), (
                f"NoK conversation event not stored: {events!r}"
            )

            # ---- 4. Refresh; Next of kin tab shows the saved details ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            nok = open_tab(page, "Next of kin")
            expect(nok.get_by_text(NOK_NAME, exact=False).first).to_be_visible(timeout=10000)
            expect(nok.get_by_text(NOK_CONTACT, exact=False).first).to_be_visible()

            # ---- 5. Edit form pre-populated with the saved details ----
            dialog = open_edit(page)
            expect(text_input(dialog, "Name")).to_have_value(NOK_NAME, timeout=10000)
            expect(text_input(dialog, "Relationship")).to_have_value(NOK_REL)
            expect(text_input(dialog, "Contact details")).to_have_value(NOK_CONTACT)
            expect(text_input(dialog, "Updated by (staff name)")).to_have_value(NOK_UPDATED_BY)
            dialog.get_by_role("button", name="Cancel").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=10000)

            # ---- 6. Timeline shows the NoK conversation event ----
            panel = open_tab(page, "Timeline")
            nok_row = panel.locator("li", has_text=EVENT_DETAILS).first
            expect(nok_row).to_be_visible(timeout=10000)
            expect(nok_row.get_by_text(expected_uk_date, exact=False)).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "nok_update_persists_and_timeline.png"))
            browser.close()

        print(
            "PASS: Next of kin details + last spoken date persisted across a refresh "
            "(NoK tab + Edit form) and the family conversation appears on the Timeline"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
