"""
End-to-end test (UI-driven): recording a Treatment Escalation Plan (TEP) with
escalation details through the real Edit-patient form persists the fields, and
they survive the patient being discharged while remaining editable afterwards.

This complements tep-persists-after-discharge.e2e.py (which drives the RPC layer
directly) by exercising the genuine on-screen widgets a clinician uses:

  1. RECORD (UI)     — open an admitted patient, click Edit, switch on
     "Treatment escalation plan (TEP) in place", type the escalation details,
     and save. Escalation & Resus tab shows "TEP in place" + the details;
     the database row confirms tep_in_place=true and tep_details.
  2. DISCHARGE       — on the Status tab, move the patient to "Discharged" with
     a destination + date.
  3. PERSIST (DISCHARGED) — reload; the Escalation & Resus tab still shows the
     TEP badge and details, and the DB still has them (discharge did not wipe
     the escalation plan).
  4. EDITABLE (after)— open Edit again on the discharged record, change the TEP
     details, save; reload and confirm the new escalation details render and
     persist while the status stays "discharged".

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/tep-record-ui-persists-after-discharge.e2e.py
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

MARKER = f"E2E-TEPUI-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.E.P."

TEP_1 = f"Ward-based care, no further ICU escalation {MARKER}"
TEP_2 = f"Ceiling of care revised after MDT — for ward NIV only {MARKER}"
DESTINATION = f"Ward 6 {MARKER}"


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
            "age": 79,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,tep_in_place,tep_details,discharge_destination",
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


def open_edit_form(page):
    page.get_by_role("button", name="Edit").first.click()
    expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(timeout=10000)
    return page.get_by_role("dialog")


def set_tep_details(page, details, tep_already_on):
    """Open Edit, ensure the TEP switch is on, set the details, and save."""
    dialog = open_edit_form(page)
    tep_switch = dialog.get_by_role("switch").first
    if not tep_already_on:
        tep_switch.click()
    expect(tep_switch).to_have_attribute("data-state", "checked", timeout=5000)
    textarea = dialog.get_by_label("TEP details")
    textarea.fill(details)
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("heading", name="Edit patient")).to_have_count(0, timeout=10000)


def open_escalation_tab(page):
    tab = page.get_by_role("tab", name="Escalation & Resus")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def discharge_via_status(page, today):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    panel = page.get_by_role("tabpanel")
    panel.get_by_role("combobox").click()
    page.get_by_role("option", name="Discharged").click()
    expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
    # British DatePicker: open popover and click today's cell (data-day = JS
    # toLocaleDateString(), e.g. "7/10/2026").
    page.get_by_role("button", name="DD/MM/YYYY").click()
    now = datetime.now(timezone.utc)
    data_day = f"{now.month}/{now.day}/{now.year}"
    cell = page.locator(f"button[data-day='{data_day}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()
    panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DESTINATION)
    panel.get_by_role("button", name="Update status").click()
    expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)


def reload_authed(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        today = datetime.now(timezone.utc).date().isoformat()

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

            # ---- 1. RECORD TEP + escalation details via the Edit form ----
            set_tep_details(page, TEP_1, tep_already_on=False)
            panel = open_escalation_tab(page)
            expect(panel.get_by_text("TEP in place")).to_be_visible(timeout=10000)
            expect(panel.get_by_text(TEP_1, exact=False)).to_be_visible(timeout=10000)
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place not stored"
            assert row["tep_details"] == TEP_1, f"tep_details not stored: {row['tep_details']!r}"
            page.screenshot(path=str(SCREENSHOTS / "tepui_recorded.png"))

            # ---- 2. DISCHARGE ----
            discharge_via_status(page, today)

            # ---- 3. PERSIST after discharge ----
            reload_authed(page)
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"not discharged: {row['status']!r}"
            assert row["tep_in_place"] is True, "TEP flag lost on discharge"
            assert row["tep_details"] == TEP_1, "TEP details lost on discharge"
            panel = open_escalation_tab(page)
            expect(panel.get_by_text("TEP in place")).to_be_visible(timeout=10000)
            expect(panel.get_by_text(TEP_1, exact=False)).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "tepui_after_discharge.png"))

            # ---- 4. STILL EDITABLE once discharged ----
            set_tep_details(page, TEP_2, tep_already_on=True)
            reload_authed(page)
            final = read_patient(patient_id)
            assert final["tep_details"] == TEP_2, (
                f"post-discharge TEP edit did not persist: {final['tep_details']!r}"
            )
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit: {final['status']!r}"
            )
            panel = open_escalation_tab(page)
            expect(panel.get_by_text(TEP_2, exact=False)).to_be_visible(timeout=10000)
            assert panel.get_by_text(TEP_1, exact=False).count() == 0, (
                "old TEP details should no longer be shown"
            )
            page.screenshot(path=str(SCREENSHOTS / "tepui_edited_after_discharge.png"))

            browser.close()

        print(
            "PASS: TEP + escalation details recorded via UI persist through "
            "discharge and stay editable"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
