"""
End-to-end test (UI-driven): setting a discharge destination and changing the
patient status to "discharged" through the real Status tab form persists the
stored fields and leaves the discharged record fully editable.

Unlike discharge-record-editable.e2e.py (which exercises the server-function
RPC layer directly), this test drives the genuine on-screen widgets exactly as
a clinician would:

  1. DISCHARGE (UI)  — open an admitted patient, go to the Status tab, pick
     "Discharged" from the status <Select>, choose a discharge date in the
     British DatePicker (today), type a discharge destination, and click
     "Update status".
  2. PERSIST (DB)    — read the row straight from the database and confirm
     status=discharged and the exact discharge_destination were stored.
  3. PERSIST (RELOAD)— hard-reload the page, reopen the Status tab, and confirm
     the status still reads "Discharged" and the destination input still holds
     the saved value.
  4. EDITABLE (UI)   — on the now-discharged record, change the discharge
     destination in the same input, save again, reload, and confirm the new
     value persisted (DB + UI) while the old value is gone and the status is
     still discharged.

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharge-destination-ui-persistence.e2e.py
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

MARKER = f"E2E-DDUI-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "U.I.D."

DEST_1 = f"Ward 8 {MARKER}"
DEST_2 = f"Home with district nurse {MARKER}"


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
        "&select=status,discharge_date,discharge_destination",
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
    # react-day-picker v9 marks today's cell with data-today="true".
    today_cell = page.locator("button[data-today='true']").first
    expect(today_cell).to_be_visible(timeout=5000)
    today_cell.click()


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

            # Discharge-date + destination inputs only appear once "Discharged".
            expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
            pick_today(page)

            dest_input = panel.get_by_placeholder("e.g. Ward, another hospital, home")
            dest_input.fill(DEST_1)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "discharge_ui_saved.png"))

            # ---- 2. PERSIST in the database ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status not stored: {row['status']!r}"
            assert row["discharge_destination"] == DEST_1, (
                f"destination not stored: {row['discharge_destination']!r}"
            )
            assert row["discharge_date"] == today, (
                f"discharge date not stored: {row['discharge_date']!r} != {today!r}"
            )

            # ---- 3. PERSIST across a hard reload ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text("Discharged", exact=False).first).to_be_visible(
                timeout=10000
            )
            panel = open_status_tab(page)
            expect(
                panel.locator(f"input[value='{DEST_1}']")
            ).to_have_count(1, timeout=10000)

            # ---- 4. STILL EDITABLE once discharged ----
            dest_input = panel.get_by_placeholder("e.g. Ward, another hospital, home")
            dest_input.fill(DEST_2)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            final = read_patient(patient_id)
            assert final["discharge_destination"] == DEST_2, (
                f"edited destination did not persist: {final['discharge_destination']!r}"
            )
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit: {final['status']!r}"
            )

            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            panel = open_status_tab(page)
            expect(panel.locator(f"input[value='{DEST_2}']")).to_have_count(
                1, timeout=10000
            )
            expect(panel.locator(f"input[value='{DEST_1}']")).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "discharge_ui_edited.png"))

            browser.close()

        print(
            "PASS: discharge destination + status set via UI persist to the DB, "
            "survive reload, and the discharged record stays editable"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
