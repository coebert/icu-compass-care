"""
End-to-end test: setting a DNACPR (decision not to attempt CPR) with a date and
details in the form persists across a refresh (the Edit form comes back
pre-populated and editable) AND the DNACPR decision appears on the Timeline.

The DNACPR controls live in src/components/PatientForm.tsx:
  - "DNACPR — decision not to attempt CPR" -> dnacpr_decision + dnacpr_date
                                              + dnacpr_details
Read back on the patient detail page under the "Escalation & Resus" tab, and on
the "Timeline" tab (src/routes/_authenticated/patients.$patientId.tsx).

The Timeline auto-surfaces admission / discharge / death / status-change /
investigation events; a DNACPR decision is recorded as a Timeline "key event"
(the Add event dialog). This test therefore models the real clinician flow: set
the DNACPR in the form, then log the resuscitation decision on the Timeline.

Steps:
  1. Seed an ADMITTED patient with NO DNACPR decision.
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Switch ON DNACPR, pick today's date + enter DNACPR details; Save.
  4. Add a Timeline key event documenting the DNACPR decision.
  5. Confirm the database stored dnacpr_decision + dnacpr_date + dnacpr_details
     and the event row.
  6. Hard-refresh; re-open Edit and verify the DNACPR switch is ON and the
     details are pre-populated (persist + editable).
  7. Open the Timeline tab and confirm the DNACPR event appears with its details
     and today's date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/dnacpr-set-persists-and-timeline-after-refresh.e2e.py
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

MARKER = f"E2EDNAS{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.N.Set"  # <= 10 chars
DNACPR_DETAILS = f"DNACPR agreed with patient and family {MARKER}"
EVENT_DETAILS = f"DNACPR decision documented and communicated {MARKER}"


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
            "age": 81,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            "weight_kg": 70,
            "dnacpr_decision": False,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=dnacpr_decision,dnacpr_details,dnacpr_date",
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


def dnacpr_details_field(dialog):
    return dialog.locator(
        "xpath=.//label[normalize-space()='DNACPR details']/following-sibling::input[1]"
    )


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
        today_iso = now.date().isoformat()
        data_day = f"{now.month}/{now.day}/{now.year}"
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

            # ---- 1. Set DNACPR: switch ON + date + details ----
            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            dnacpr_switch = switches.nth(2)  # [0]=isolation, [1]=TEP, [2]=DNACPR
            dnacpr_switch.scroll_into_view_if_needed()
            dnacpr_switch.click()
            expect(dnacpr_switch).to_have_attribute("data-state", "checked", timeout=5000)

            dnacpr_date_btn = dialog.locator(
                "xpath=.//label[normalize-space()='DNACPR date']/following::button[1]"
            )
            selected = False
            for _ in range(4):
                dnacpr_date_btn.click()
                cell = page.locator(f"button[data-day='{data_day}']").first
                expect(cell).to_be_visible(timeout=5000)
                cell.click(force=True)
                page.wait_for_timeout(400)
                if "DD/MM/YYYY" not in (dnacpr_date_btn.inner_text() or ""):
                    selected = True
                    break
            assert selected, "DNACPR date did not register in the picker"
            dnacpr_details_field(dialog).fill(DNACPR_DETAILS)
            save_edit(page, dialog)

            # ---- 2. Log the DNACPR decision on the Timeline ----
            panel = open_tab(page, "Timeline")
            add_timeline_event(page, panel, EVENT_DETAILS)

            # ---- 3. Database persistence ----
            row = read_patient(patient_id)
            assert row["dnacpr_decision"] is True, "dnacpr_decision not stored"
            assert row["dnacpr_details"] == DNACPR_DETAILS, f"dnacpr_details: {row['dnacpr_details']!r}"
            assert (row["dnacpr_date"] or "").startswith(today_iso), (
                f"dnacpr_date: {row['dnacpr_date']!r}"
            )
            events = read_events(patient_id)
            assert any(e["description"] == EVENT_DETAILS for e in events), (
                f"DNACPR event not stored: {events!r}"
            )

            # ---- 4. Refresh; re-open Edit — DNACPR persists + editable ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            expect(switches.nth(2)).to_have_attribute("data-state", "checked", timeout=5000)
            expect(dnacpr_details_field(dialog)).to_have_value(DNACPR_DETAILS, timeout=10000)
            dialog.get_by_role("button", name="Cancel").click()
            expect(page.get_by_role("heading", name="Edit patient")).to_have_count(0, timeout=10000)

            # ---- 5. Escalation & Resus tab shows the saved DNACPR ----
            esc = open_tab(page, "Escalation & Resus")
            expect(esc.get_by_text("DNACPR decision made", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(esc.get_by_text(DNACPR_DETAILS, exact=False).first).to_be_visible()
            expect(esc.get_by_text(expected_uk_date, exact=False).first).to_be_visible()

            # ---- 6. Timeline shows the DNACPR event with details + date ----
            panel = open_tab(page, "Timeline")
            dnacpr_row = panel.locator("li", has_text=EVENT_DETAILS).first
            expect(dnacpr_row).to_be_visible(timeout=10000)
            expect(dnacpr_row.get_by_text(expected_uk_date, exact=False)).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "dnacpr_set_persists_and_timeline.png"))
            browser.close()

        print(
            "PASS: DNACPR set in the form persisted across a refresh (Edit form "
            "pre-populated and editable) and the decision appears on the Timeline"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
