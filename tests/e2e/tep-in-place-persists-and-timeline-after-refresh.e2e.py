"""
End-to-end test: setting a Treatment Escalation Plan (TEP) in place — with
details — persists across a refresh (the Edit form comes back pre-populated and
editable) AND the escalation decision appears on the patient Timeline.

The TEP controls live in src/components/PatientForm.tsx:
  - "Treatment escalation plan (TEP) in place"  -> tep_in_place + tep_details
Read back on the patient detail page under the "Escalation & Resus" tab, and on
the "Timeline" tab (src/routes/_authenticated/patients.$patientId.tsx).

The Timeline auto-surfaces admission / discharge / death / status-change /
investigation events, but a TEP decision is recorded as a Timeline "key event"
(the Add event dialog). This test therefore models the real clinician flow:
set the TEP in place in Edit, THEN log the escalation decision on the Timeline
as a key event whose details carry the TEP wording.

Steps:
  1. Seed an ADMITTED patient with NO TEP in place.
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Switch ON "TEP in place" + enter TEP details; Save.
  4. Add a Timeline key event ("Other") documenting the escalation decision.
  5. Confirm the database stored tep_in_place + tep_details and the event row.
  6. Hard-refresh; confirm the Escalation & Resus tab shows the saved TEP.
  7. EDITABILITY: re-open Edit and assert the TEP switch is ON and the details
     are pre-populated (still editable).
  8. Open the Timeline tab and confirm the escalation key event appears with its
     details and today's date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/tep-in-place-persists-and-timeline-after-refresh.e2e.py
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

MARKER = f"E2ETEP{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.E.Plan"  # <= 10 chars
TEP_DETAILS = f"Ceiling of care: ward-based, not for ICU re-admission {MARKER}"
EVENT_DETAILS = f"Escalation decision agreed with consultant and family {MARKER}"


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
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "9",
            "status": "admitted",
            "weight_kg": 76,
            "tep_in_place": False,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details",
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


def open_edit(page):
    page.get_by_role("button", name="Edit").first.click()
    expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(timeout=10000)
    return page.get_by_role("dialog")


def save_edit(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("heading", name="Edit patient")).to_have_count(0, timeout=10000)


def tep_details_field(dialog):
    return dialog.locator(
        "xpath=.//label[normalize-space()='TEP details']/following-sibling::textarea[1]"
    )


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        now = datetime.now(timezone.utc)
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

            # ---- 1. Set TEP in place + details ----
            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            # Order in PatientForm.tsx: [0]=isolation, [1]=TEP, [2]=DNACPR.
            tep_switch = switches.nth(1)
            tep_switch.scroll_into_view_if_needed()
            tep_switch.click()
            expect(tep_switch).to_have_attribute("data-state", "checked", timeout=5000)
            tep_details_field(dialog).fill(TEP_DETAILS)
            save_edit(page, dialog)

            # ---- 2. Log the escalation decision on the Timeline ----
            panel = open_tab(page, "Timeline")
            panel.get_by_role("button", name="Add event").click()
            add_dialog = page.get_by_role("dialog")
            expect(add_dialog.get_by_role("heading", name="Add key event")).to_be_visible(
                timeout=10000
            )
            add_dialog.locator(
                "xpath=.//label[normalize-space()='Details (optional)']/following::textarea[1]"
            ).fill(EVENT_DETAILS)
            add_dialog.get_by_role("button", name="Add event").click()
            expect(add_dialog.get_by_role("heading", name="Add key event")).to_have_count(
                0, timeout=10000
            )

            # ---- 3. Database persistence ----
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place not stored"
            assert row["tep_details"] == TEP_DETAILS, f"tep_details: {row['tep_details']!r}"
            events = read_events(patient_id)
            assert any(e["description"] == EVENT_DETAILS for e in events), (
                f"escalation event not stored: {events!r}"
            )

            # ---- 4. Refresh; Escalation & Resus tab shows the saved TEP ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            esc = open_tab(page, "Escalation & Resus")
            expect(esc.get_by_text("TEP in place", exact=False).first).to_be_visible(timeout=10000)
            expect(esc.get_by_text(TEP_DETAILS, exact=False).first).to_be_visible()

            # ---- 5. EDITABILITY: Edit form pre-populated + editable ----
            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            expect(switches.nth(1)).to_have_attribute("data-state", "checked", timeout=5000)
            expect(tep_details_field(dialog)).to_have_value(TEP_DETAILS, timeout=10000)
            dialog.get_by_role("button", name="Cancel").click()
            expect(page.get_by_role("heading", name="Edit patient")).to_have_count(0, timeout=10000)

            # ---- 6. Timeline shows the escalation event with details + date ----
            panel = open_tab(page, "Timeline")
            expect(panel.get_by_text(EVENT_DETAILS, exact=False).first).to_be_visible(timeout=10000)
            expect(panel.get_by_text(expected_uk_date, exact=False).first).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "tep_persists_and_timeline.png"))
            browser.close()

        print(
            "PASS: TEP in place + details persisted and stayed editable across a "
            "refresh, and the escalation decision appears on the Timeline"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
