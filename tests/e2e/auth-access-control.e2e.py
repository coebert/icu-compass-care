"""
End-to-end test: the app blocks all access when logged out, and only permits
viewing AND editing once the user is authenticated.

This complements patient-auth-guard.e2e.py (which focuses on the blocking
boundary) by proving the positive path end-to-end: after authenticating, a real
edit issued through the app's genuine TanStack server-function RPC client both
SUCCEEDS and PERSISTS — and that the same edit was impossible while logged out.

What it asserts:

  1. VIEW blocked (route)   — logged out, /patients redirects to /auth.
  2. VIEW blocked (data)    — logged out, getPatient() is rejected (auth error).
  3. EDIT blocked (data)    — logged out, updatePatient() is rejected (auth error)
                              AND the record is verifiably unchanged in the DB.
  4. VIEW allowed after auth — once a valid session is restored, /patients renders
                              the board and getPatient() returns the record.
  5. EDIT allowed after auth — updatePatient() succeeds, and the new value is
                              confirmed both by re-reading through the app and by
                              an independent admin read of the database.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/auth-access-control.e2e.py
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-ACCESS-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
INITIAL_MGMT = f"Initial management note {MARKER}"
EDITED_MGMT = f"Edited AFTER auth {MARKER}"
BLOCKED_MGMT = f"Edited WHILE logged out {MARKER}"


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


CALL_SERVER_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn({ data: arg.data });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def call_fn(page, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": FUNCTIONS_MODULE, "name": name, "data": data}
    )


def assert_blocked(outcome, label):
    assert not outcome["ok"], f"{label} should be blocked while logged out, but it succeeded"
    assert "unauthor" in outcome["error"].lower(), (
        f"{label} rejected, but not for an auth reason: {outcome['error']}"
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

            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Logged out: the board route redirects to /auth ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "access_1_blocked.png"))

            # ---- 2. Logged out: viewing data is rejected ----
            assert_blocked(call_fn(page, "getPatient", {"id": patient_id}),
                           "Viewing a record (getPatient)")

            # ---- 3. Logged out: editing is rejected AND nothing changed ----
            assert_blocked(
                call_fn(page, "updatePatient",
                        {"id": patient_id, "current_management": BLOCKED_MGMT}),
                "Editing a record (updatePatient)",
            )
            assert read_management(patient_id) == INITIAL_MGMT, (
                "record was mutated while logged out — the edit boundary leaked"
            )

            # ---- 4. Authenticate: viewing is now allowed ----
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"still redirected to /auth while logged in: {page.url}"
            expect(page.get_by_role("heading", name="Patient board")).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "access_2_authed.png"))

            view = call_fn(page, "getPatient", {"id": patient_id})
            assert view["ok"], f"getPatient should succeed once authenticated: {view.get('error')}"

            # ---- 5. Authenticated: editing succeeds and persists ----
            edit = call_fn(page, "updatePatient",
                           {"id": patient_id, "current_management": EDITED_MGMT})
            assert edit["ok"], f"updatePatient should succeed once authenticated: {edit.get('error')}"

            # Confirm via the app's own read...
            reread = call_fn(page, "getPatient", {"id": patient_id})
            assert reread["ok"], f"re-read failed: {reread.get('error')}"
            assert reread["result"]["current_management"] == EDITED_MGMT, (
                f"edit not reflected in app read: {reread['result'].get('current_management')!r}"
            )
            # ...and via an independent admin read of the database.
            assert read_management(patient_id) == EDITED_MGMT, (
                "authenticated edit did not persist to the database"
            )
            page.screenshot(path=str(SCREENSHOTS / "access_3_edited.png"))

            browser.close()

        print("PASS: access blocked logged out; view + edit allowed and persisted after auth")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
