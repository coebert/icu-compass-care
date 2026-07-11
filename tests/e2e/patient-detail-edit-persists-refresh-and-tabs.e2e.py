"""
End-to-end test: authenticate, open a patient DETAIL page, edit a key field,
save through the UI, then verify the updated value persists across a page
refresh AND in a SEPARATE browser tab (independent page in the same context).

Flow:
  1. Restore a valid clinician session.
  2. Navigate to /patients/<id> and open the Edit dialog.
  3. Change the "current management" field and Save.
  4. Reload the SAME tab and confirm the edited value renders (not the old one).
  5. Open a SECOND tab, navigate to the same detail page, and confirm the
     edited value renders there too (with no stale/pre-edit value leaking).
  6. Confirm the database holds the edited value (independent admin read).

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-detail-edit-persists-refresh-and-tabs.e2e.py
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

MARKER = f"E2E-PERSIST-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
INITIAL_MGMT = f"Initial management {MARKER}"
EDITED_MGMT = f"Edited via UI {MARKER}"
PATIENT_NAME = "Y.P."


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
            "age": 58,
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


def open_detail(context, patient_id):
    """Open the detail page in a fresh tab and wait for it to render."""
    page = context.new_page()
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"
    expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)
    return page


def assert_shows_edited(page, where):
    body = page.evaluate("() => document.body.innerText")
    assert EDITED_MGMT in body, f"[{where}] edited value not visible: expected {EDITED_MGMT!r}"
    assert INITIAL_MGMT not in body, f"[{where}] stale pre-edit value leaked: {INITIAL_MGMT!r}"


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})

            # Restore the session on the origin before hitting a protected route.
            boot = context.new_page()
            boot.goto(BASE_URL, wait_until="domcontentloaded")
            boot.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            boot.close()

            # ---- 1. Open detail page and edit the management field ----
            page = open_detail(context, patient_id)
            expect(page.get_by_role("tab", name="Overview")).to_be_visible(timeout=15000)

            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)

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

            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "persist_1_saved.png"))

            # ---- 2. Database confirms the edit persisted ----
            deadline = time.time() + 15
            persisted = None
            while time.time() < deadline:
                persisted = read_management(patient_id)
                if persisted == EDITED_MGMT:
                    break
                time.sleep(0.5)
            assert persisted == EDITED_MGMT, f"UI edit did not persist to DB: {persisted!r}"

            # ---- 3. Refresh the SAME tab and confirm the edited value renders ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)
            assert_shows_edited(page, "same tab after refresh")
            page.screenshot(path=str(SCREENSHOTS / "persist_2_refresh.png"))

            # ---- 4. Open a SECOND tab and confirm the edited value renders there ----
            page2 = open_detail(context, patient_id)
            assert_shows_edited(page2, "second tab")
            page2.screenshot(path=str(SCREENSHOTS / "persist_3_second_tab.png"))

            browser.close()

        print("PASS: UI edit persisted to DB, survives refresh, and shows in a second tab with no stale value")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
