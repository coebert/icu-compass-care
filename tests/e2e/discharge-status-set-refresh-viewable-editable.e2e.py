"""
End-to-end test (UI-driven): changing a patient's status to "discharged" with a
discharge destination through the real app, then hard-refreshing, leaves the
record fully VIEWABLE and EDITABLE afterwards.

Flow, exercised entirely through the on-screen widgets a clinician uses:

  1. DISCHARGE (UI)  — open an admitted patient, go to the Status tab, choose
     "Discharged", pick today's discharge date in the British DatePicker, type a
     discharge destination, and click "Update status".
  2. PERSIST (DB)    — read the row from the database and confirm status =
     discharged and the exact discharge_destination were stored.
  3. REFRESH         — hard-reload the page (Cmd/F5 equivalent).
  4. VIEWABLE        — after the refresh the patient name, the "Discharged"
     status, and the saved destination all still render.
  5. EDITABLE        — open the Edit dialog on the now-discharged record, change
     the current-management note, save, and confirm the edit persists (DB + a
     final reload of the UI) while the status stays "discharged".

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharge-status-set-refresh-viewable-editable.e2e.py
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

MARKER = f"E2E-DSRVE-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.R.V."

INITIAL_MGMT = f"Initial management {MARKER}"
POST_DISCHARGE_MGMT = f"Post-discharge management edit {MARKER}"
DEST = f"Ward 12 step-down {MARKER}"


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
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
            "current_management": INITIAL_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination,current_management",
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


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def pick_today(page):
    """Open the discharge-date DatePicker popover and select today's date."""
    page.get_by_role("button", name="DD/MM/YYYY").click()
    now = datetime.now(timezone.utc)
    data_day = f"{now.month}/{now.day}/{now.year}"
    cell = page.locator(f"button[data-day='{data_day}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


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

            # ---- 1. DISCHARGE via the Status tab UI ----
            panel = open_status_tab(page)
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()

            expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
            pick_today(page)

            dest_input = panel.get_by_placeholder("e.g. Ward, another hospital, home")
            dest_input.fill(DEST)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "dsrve_1_discharged.png"))

            # ---- 2. PERSIST in the database ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status not stored: {row['status']!r}"
            assert row["discharge_destination"] == DEST, (
                f"destination not stored: {row['discharge_destination']!r}"
            )
            assert row["discharge_date"] == today, (
                f"discharge date not stored: {row['discharge_date']!r} != {today!r}"
            )

            # ---- 3. REFRESH (hard reload) ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"

            # ---- 4. VIEWABLE after the refresh ----
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            panel = open_status_tab(page)
            expect(panel.get_by_text("Discharged", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.locator(f"input[value='{DEST}']")).to_have_count(
                1, timeout=10000
            )
            page.screenshot(path=str(SCREENSHOTS / "dsrve_2_viewable_after_refresh.png"))

            # ---- 5. EDITABLE after discharge via the Edit dialog ----
            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)

            handle = dialog.evaluate_handle(
                "(root, txt) => Array.from(root.querySelectorAll('textarea'))"
                ".find(t => t.value === txt)",
                INITIAL_MGMT,
            )
            assert handle.as_element(), (
                "management textarea not pre-populated on the discharged record"
            )
            ta = handle.as_element()
            ta.click()
            ta.press("Control+A")
            ta.press("Delete")
            ta.type(POST_DISCHARGE_MGMT)
            assert ta.input_value() == POST_DISCHARGE_MGMT, (
                "management field did not accept edits on the discharged record"
            )
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "dsrve_3_edited.png"))

            # ---- 5a. Edit persisted to the DB, status still discharged ----
            deadline = time.time() + 15
            final = None
            while time.time() < deadline:
                final = read_patient(patient_id)
                if final["current_management"] == POST_DISCHARGE_MGMT:
                    break
                time.sleep(0.5)
            assert final["current_management"] == POST_DISCHARGE_MGMT, (
                f"post-discharge edit did not persist: {final['current_management']!r}"
            )
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit: {final['status']!r}"
            )
            assert final["discharge_destination"] == DEST, (
                "discharge destination lost after editing management note"
            )

            # ---- 5b. Edit visible after another refresh ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(POST_DISCHARGE_MGMT, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_text(INITIAL_MGMT, exact=False)).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "dsrve_4_edit_visible_after_refresh.png"))

            browser.close()

        print(
            "PASS: status set to discharged (with destination) via UI persists, and "
            "after refresh the record stays viewable and editable"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
