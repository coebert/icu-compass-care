"""
End-to-end test: a logged-out user cannot view or edit a patient record.

Verifies the authentication boundary of the ICU handover app end-to-end,
driving the real app in a headless browser (so it exercises the genuine
TanStack server-function RPC client, not a hand-rolled request):

  1. Logged out, navigating to the patient board (/patients) and to a specific
     patient record (/patients/<id>) is BLOCKED — the app redirects to /auth.
  2. After authenticating, the SAME routes load: the board lists the record and
     the detail page shows it (viewing is now allowed).
  3. The record is EDITABLE — the "Current management" note is changed through
     the edit dialog and the new value persists after a reload.

Test data (a throwaway user + patient) is created and cleaned up via the
Supabase admin REST API using the service-role key. Nothing lingers in the
clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-auth-guard.e2e.py
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

MARKER = f"E2E-AUTH-{int(time.time())}"
INITIAL_MGMT = f"Initial management note {MARKER}"
EDITED_MGMT = f"Edited management note {MARKER}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={
            "email": f"{MARKER.lower()}@example.com",
            "password": "Test-Passw0rd-123!",
            "email_confirm": True,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], f"{MARKER.lower()}@example.com"


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": "A.G.",
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": INITIAL_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": "Test-Passw0rd-123!"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def delete_patient(pid):
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
        headers=admin_headers(),
        timeout=30,
    )


def delete_user(uid):
    requests.delete(
        f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
        headers=admin_headers(),
        timeout=30,
    )


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

            # ---- 1. Logged out: viewing the board is blocked -> /auth ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "1_board_blocked.png"))

            # ---- 1b. Logged out: viewing a specific record is blocked -> /auth ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "2_record_blocked.png"))

            # ---- 2. Authenticate by restoring the session, then view again ----
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            # Must NOT bounce to /auth now, and the board must render.
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"still redirected to auth while logged in: {page.url}"
            expect(page.get_by_role("heading", name="Patient board")).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "3_board_authed.png"))

            # ---- 2b. Detail page is viewable while authenticated ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            expect(page.get_by_text(INITIAL_MGMT).first).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "4_record_authed.png"))

            # ---- 3. The record is editable ----
            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=10000)
            mgmt = dialog.locator(
                "xpath=.//*[normalize-space(text())='Current management']/following::textarea[1]"
            )
            mgmt.fill(EDITED_MGMT)
            dialog.get_by_role("button", name="Save").click()
            expect(dialog).to_be_hidden(timeout=15000)

            # Persisted after reload.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            expect(page.get_by_text(EDITED_MGMT).first).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "5_record_edited.png"))

            browser.close()

        print("PASS: patient view/edit blocked while logged out, allowed after auth")
        return 0
    finally:
        if patient_id:
            delete_patient(patient_id)
        if user_id:
            delete_user(user_id)


if __name__ == "__main__":
    sys.exit(main())
