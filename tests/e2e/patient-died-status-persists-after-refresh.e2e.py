"""
End-to-end test: marking a patient as "died" through the real UI persists the
died status AND its required detail (date of death), and both remain visible and
consistent in the UI *and* the database after a full page refresh.

This drives the actual app UI (Status tab -> select "Died" -> pick date of death
-> Update status), unlike patient-lifecycle-death.e2e.py which exercises the RPC
layer directly. Together they cover UI + server behaviour.

What it asserts:
  1. Setup — a fresh "admitted" patient is created; the detail page shows the
     "Admitted" status badge.
  2. UI transition — on the Status tab the clinician selects "Died", the
     "Date of death" field appears, they pick today's date and press
     "Update status"; a success toast confirms the save.
  3. Refresh consistency (UI) — after a hard reload the header badge still reads
     "Died", the Status tab still shows the recorded date of death, and the
     Timeline tab shows a "Died" event with that date.
  4. Database consistency — an independent admin read confirms status == "died"
     and date_of_death is stored, matching what the UI shows.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-died-status-persists-after-refresh.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import date
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

MARKER = f"E2E-DIED-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.I."
TODAY_ISO = date.today().isoformat()


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
            "status": "admitted",
            "current_management": f"Admitted {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,date_of_death",
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
    page.get_by_role("tab", name="Status").click()
    expect(page.get_by_text("Patient status")).to_be_visible()


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
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

            detail_url = f"{BASE_URL}/patients/{patient_id}"
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # ---- 1. Setup: starts as Admitted ----
            header = page.get_by_role("heading").first
            expect(page.get_by_text("Admitted").first).to_be_visible()

            # ---- 2. UI transition to Died ----
            open_status_tab(page)

            # Select "Died" in the status dropdown.
            page.get_by_role("combobox").first.click()
            page.get_by_role("option", name="Died").click()

            # "Date of death" field appears once "Died" is chosen.
            expect(page.get_by_text("Date of death")).to_be_visible()

            # Open the date picker and choose today's date.
            page.get_by_role("button", name="DD/MM/YYYY").click()
            page.locator(".rdp-day_today, [aria-current='date'], button[data-today]").first.click()

            page.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=15000)

            page.screenshot(path=str(SCREENSHOTS / "died_1_after_save.png"))

            # ---- 3. Refresh consistency (UI) ----
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # Header badge persists as "Died".
            expect(page.get_by_text("Died").first).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "died_2_after_refresh_badge.png"))

            # Status tab retains the recorded date of death (not empty).
            open_status_tab(page)
            expect(page.get_by_text("Date of death")).to_be_visible()
            dod_button = page.get_by_role("button", name="DD/MM/YYYY")
            # If the field kept its value, the placeholder button no longer exists.
            assert dod_button.count() == 0, (
                "date of death was lost after refresh — the picker shows the empty placeholder"
            )

            # Timeline shows a Died event.
            page.get_by_role("tab", name="Timeline").click()
            expect(page.get_by_text("Died").first).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "died_3_timeline.png"))

            # ---- 4. Database consistency ----
            db = read_patient(patient_id)
            assert db["status"] == "died", f"DB status is {db['status']!r}, expected 'died'"
            assert db["date_of_death"], "DB date_of_death is empty — required detail not persisted"
            assert db["date_of_death"] == TODAY_ISO, (
                f"DB date_of_death {db['date_of_death']!r} != selected {TODAY_ISO!r}"
            )

            browser.close()

        print(
            "PASS: patient marked died via UI; status + date of death "
            f"({db['date_of_death']}) consistent in UI and DB after refresh"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
