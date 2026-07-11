"""
End-to-end test: opening a patient record while LOGGED OUT is blocked, and the
same record loads correctly once the user LOGS IN.

This is the full negative→positive round trip for the detail screen:

  PHASE 1 — LOGGED OUT (access blocked)
    1. Deep-link to /patients/<id> redirects to /auth.
    2. The detail UI never leaks (patient name / record tabs do not render).
    3. getPatient(<id>) via the real RPC client is rejected for an auth reason.

  PHASE 2 — LOGGED IN (record loads correctly)
    4. With a clinician session restored, /patients/<id> renders without
       bouncing to /auth.
    5. The seeded patient's name and confidential management note are visible
       in the DOM.
    6. getPatient(<id>) via the real RPC client returns the seeded record with
       the correct status and note.

A throwaway clinician user + one patient are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-record-blocked-logged-out-loads-after-login.e2e.py
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

FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"
STAMP = str(int(time.time()))
MARKER = f"E2E-LOGIN-ROUNDTRIP-{STAMP}"
PATIENT_NAME = f"Loginwood{STAMP}"
MGMT_NOTE = f"Management note {MARKER}"
PASSWORD = "Test-Passw0rd-123!"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-login-rt-{STAMP}@example.com"
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
            "current_admission": f"Admission {MARKER}",
            "current_management": MGMT_NOTE,
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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # =============== PHASE 1: LOGGED OUT — access blocked ===============
            # No session is ever restored here — this visitor is logged out.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # 1. Deep-link to the detail route redirects to /auth.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth while logged out, got {page.url}"
            )

            # 2. The detail UI must not have leaked.
            assert not page.get_by_text(PATIENT_NAME, exact=False).count(), (
                "patient name rendered on a logged-out detail page — UI leaked"
            )
            page.screenshot(path=str(SCREENSHOTS / "login_roundtrip_1_blocked.png"))

            # 3. The record data behind the detail page is rejected for auth.
            out = page.evaluate(
                CALL_SERVER_FN,
                {"module": FUNCTIONS_MODULE, "name": "getPatient", "data": {"id": patient_id}},
            )
            assert not out["ok"], "getPatient succeeded while logged out — data leaked"
            assert "unauthor" in out["error"].lower(), (
                f"getPatient rejected, but not for an auth reason: {out['error']}"
            )

            # =============== PHASE 2: LOGGED IN — record loads ================
            session = sign_in(email)
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # 4. The detail route now renders and does not bounce to /auth.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            # 5. The seeded record is visible in the DOM.
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            body = page.inner_text("body")
            assert MGMT_NOTE in body, "management note not rendered on the detail page"
            page.screenshot(path=str(SCREENSHOTS / "login_roundtrip_2_loaded.png"))

            # 6. The record data now loads correctly via the real RPC client.
            out = page.evaluate(
                CALL_SERVER_FN,
                {"module": FUNCTIONS_MODULE, "name": "getPatient", "data": {"id": patient_id}},
            )
            assert out["ok"], f"getPatient failed while logged in: {out.get('error')}"
            rec = out["result"]
            assert rec, "getPatient returned no record while logged in"
            assert rec.get("full_name") == PATIENT_NAME, (
                f"wrong name after login: {rec.get('full_name')!r}"
            )
            assert rec.get("status") == "admitted", (
                f"wrong status after login: {rec.get('status')!r}"
            )
            assert rec.get("current_management") == MGMT_NOTE, (
                f"management note mismatch after login: {rec.get('current_management')!r}"
            )

            browser.close()

        print(
            "PASS: patient record blocked while logged out (route + UI + data), "
            "and loads correctly after login"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
