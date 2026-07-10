"""
End-to-end test: after authenticating, the patient DETAIL page loads for a
selected patient and exposes EDITABLE fields for that patient.

Unlike auth-access-control.e2e.py (which drives the server-function RPC layer
directly), this test walks the real UI:

  1. Restore a valid clinician session.
  2. Navigate straight to /patients/<id>.
  3. Assert the detail view renders (patient header + record tabs), NOT just the
     board shell.
  4. Open the Edit dialog and assert the form is pre-populated with THIS
     patient's data and the fields are genuinely editable (value can be typed).
  5. Save through the UI and confirm the change persists (independent admin read).

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-detail-edit.e2e.py
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

MARKER = f"E2E-DETAIL-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
INITIAL_MGMT = f"Initial management {MARKER}"
EDITED_MGMT = f"Edited via UI {MARKER}"
PATIENT_NAME = "Z.Q."


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
            "current_management": INITIAL_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_management(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=current_management",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["current_management"]


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

            # ---- Restore the session before hitting a protected route ----
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 1. Navigate to the detail page for the selected patient ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # ---- 2. Detail view renders (header + record tabs), not the board shell ----
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_role("tab", name="Overview")).to_be_visible(timeout=15000)
            expect(page.get_by_role("tab", name="Status")).to_be_visible()
            page.screenshot(path=str(SCREENSHOTS / "detail_1_loaded.png"))

            # ---- 3. Open the Edit dialog ----
            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)

            # ---- 4. Fields are pre-populated for THIS patient and editable ----
            name_input = dialog.get_by_placeholder("e.g. J.S.")
            expect(name_input).to_have_value(PATIENT_NAME, timeout=10000)

            # Locate the management textarea by its current value and type into it.
            handle = dialog.evaluate_handle(
                "(root, txt) => Array.from(root.querySelectorAll('textarea')).find(t => t.value === txt)",
                INITIAL_MGMT,
            )
            assert handle.as_element(), "management textarea not pre-populated with this patient's note"
            ta = handle.as_element()
            ta.click()
            ta.press("Control+A")
            ta.press("Delete")
            ta.type(EDITED_MGMT)
            assert ta.input_value() == EDITED_MGMT, "management field did not accept edits"
            page.screenshot(path=str(SCREENSHOTS / "detail_2_editing.png"))

            # ---- 5. Save through the UI and confirm persistence ----
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            deadline = time.time() + 15
            persisted = None
            while time.time() < deadline:
                persisted = read_management(patient_id)
                if persisted == EDITED_MGMT:
                    break
                time.sleep(0.5)
            assert persisted == EDITED_MGMT, (
                f"UI edit did not persist to the database: {persisted!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "detail_3_saved.png"))

            browser.close()

        print("PASS: detail page loads and exposes editable fields; UI edit persisted")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
