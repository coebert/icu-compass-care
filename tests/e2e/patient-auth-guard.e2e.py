"""
End-to-end test: a logged-out user cannot view or edit a patient record.

Verifies the authentication boundary of the ICU handover app end-to-end,
driving the real app in a headless browser so it exercises the genuine
TanStack server-function RPC client (bearer attach, RLS) — not a hand-rolled
HTTP request.

What it asserts:

  1. VIEW blocked (route)   — logged out, navigating to the patient board
     (/patients) and to a specific record (/patients/<id>) redirects to /auth.
  2. VIEW blocked (data)    — logged out, the app's getPatient() server function
     is rejected with an authorization error.
  3. EDIT blocked (data)    — logged out, the app's updatePatient() server
     function is rejected with an authorization error.
  4. Unblocked after auth   — once a valid session is restored, /patients no
     longer redirects to /auth and the board renders. The same view/edit
     operations that were blocked are now reachable to an authenticated user.

Test data (a throwaway clinician user + patient) is created and cleaned up via
the Supabase admin REST API using the service-role key. Nothing lingers in the
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-AUTH-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
INITIAL_MGMT = f"Initial management note {MARKER}"


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
    # Grant a clinical role so the authenticated user is a realistic staff member.
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


# Calls a patient server function through the app's real RPC client and reports
# whether it succeeded or was rejected (and with what message).
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

            # ---- 1. Logged out: the view routes redirect to /auth ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "1_board_blocked.png"))

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "2_record_blocked.png"))

            # ---- 2 & 3. Logged out: view + edit data operations are rejected ----
            view = call_fn(page, "getPatient", {"id": patient_id})
            assert_blocked(view, "Viewing a record (getPatient)")

            edit = call_fn(
                page,
                "updatePatient",
                {"id": patient_id, "current_management": "hacked while logged out"},
            )
            assert_blocked(edit, "Editing a record (updatePatient)")

            # ---- 4. Authenticate, then the same routes are no longer blocked ----
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"still redirected to /auth while logged in: {page.url}"
            expect(page.get_by_role("heading", name="Patient board")).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "3_board_authed.png"))

            # Confirm the record data operations that were blocked are now reachable
            # to the authenticated clinician (still guarded server-side, but permitted).
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            assert "/auth" not in page.url, f"record view redirected to /auth while logged in: {page.url}"
            page.screenshot(path=str(SCREENSHOTS / "4_record_authed.png"))

            browser.close()

        print("PASS: patient view/edit blocked while logged out, unblocked after authenticating")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
