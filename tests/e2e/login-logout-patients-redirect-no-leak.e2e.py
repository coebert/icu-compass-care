"""
End-to-end test: a full login -> logout -> logged-out-access cycle proves the
patient routes are sealed once the session ends.

Unlike patients-logged-out-no-data-leak.e2e.py (which never authenticates), this
test exercises the real transition a clinician makes: they sign in, see patient
data, click "Sign out" in the app chrome, and then try to reach the patient
board and a patient detail route again. After logout everything must bounce to
/auth and no seeded patient marker may survive anywhere in the DOM.

Flow, in order:
  1. Seed a marker-bearing patient + a clinician user (admin REST API).
  2. Log in (session written to localStorage), open /patients, and CONFIRM the
     seeded marker IS visible — proving the marker is real and normally renders.
  3. Click the app's "Sign out" control and wait for the redirect to /auth.
     Assert the session is gone from localStorage.
  4. LOGGED OUT, deep-link to /patients and /patients/<id>. Each must redirect
     to /auth, must not render the patient-detail tabs, and must contain NO
     seeded marker anywhere in the DOM (outerHTML + innerText + <title>).

The throwaway patient + user are removed via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/login-logout-patients-redirect-no-leak.e2e.py
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

STAMP = str(int(time.time()))
# Unique + unguessable so a DOM hit can only come from the seeded row.
NAME_MARKER = f"Logout{STAMP}"
HOSPITAL_MARKER = f"HN{STAMP}"
WARD_MARKER = f"WARD{STAMP}"
BED_MARKER = f"BED{STAMP}"
MGMT_MARKER = f"Mgmt{STAMP}"
ADMISSION_MARKER = f"Adm{STAMP}"
NOK_MARKER = f"Kin{STAMP}"
TEP_MARKER = f"Tep{STAMP}"
PASSWORD = "Test-Passw0rd-123!"

MARKERS = [
    NAME_MARKER,
    HOSPITAL_MARKER,
    WARD_MARKER,
    BED_MARKER,
    MGMT_MARKER,
    ADMISSION_MARKER,
    NOK_MARKER,
    TEP_MARKER,
]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-logout-{STAMP}@example.com"
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
            "full_name": NAME_MARKER,
            "age": 63,
            "hospital_number": HOSPITAL_MARKER,
            "location_type": "icu",
            "ward": WARD_MARKER,
            "bed": BED_MARKER,
            "status": "admitted",
            "current_admission": ADMISSION_MARKER,
            "current_management": MGMT_MARKER,
            "nok_name": NOK_MARKER,
            "tep_in_place": True,
            "tep_details": TEP_MARKER,
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


def find_leaks(page):
    """Return every seeded marker that appears anywhere in the current DOM."""
    haystack = page.evaluate(
        """() => [
             document.documentElement.outerHTML,
             document.body ? document.body.innerText : '',
             document.title,
           ].join('\\n')"""
    )
    return [m for m in MARKERS if m in haystack]


def assert_blocked(page, url, label):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_url("**/auth", timeout=15000)
    assert page.url.rstrip("/").endswith("/auth"), (
        f"[{label}] expected redirect to /auth, got {page.url}"
    )
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)

    assert not page.get_by_role("tab", name="Overview").count(), (
        f"[{label}] patient detail tabs rendered while logged out — UI leaked"
    )

    leaks = find_leaks(page)
    assert not leaks, (
        f"[{label}] patient data leaked into the DOM after logout: {leaks}"
    )


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # ---- 1 & 2. Log in and confirm the marker really renders ----
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )
            expect(
                page.get_by_text(NAME_MARKER, exact=False).first
            ).to_be_visible(timeout=20000)
            page.screenshot(path=str(SCREENSHOTS / "logout_before_signout.png"))

            # ---- 3. Click the app's "Sign out" control ----
            page.get_by_role("button", name="Sign out").first.click()
            page.wait_for_url("**/auth", timeout=15000)
            page.wait_for_load_state("networkidle")

            token_after = page.evaluate(
                "(k) => window.localStorage.getItem(k)", STORAGE_KEY
            )
            assert not token_after, (
                "session token still present in localStorage after sign out"
            )
            page.screenshot(path=str(SCREENSHOTS / "logout_after_signout.png"))

            # ---- 4. Logged out: patient routes must redirect + not leak ----
            assert_blocked(page, f"{BASE_URL}/patients", "board")
            page.screenshot(path=str(SCREENSHOTS / "logout_board_no_leak.png"))

            assert_blocked(page, f"{BASE_URL}/patients/{patient_id}", "detail")
            page.screenshot(path=str(SCREENSHOTS / "logout_detail_no_leak.png"))

            browser.close()

        print(
            "PASS: after login -> Sign out, /patients and /patients/<id> redirect "
            "to /auth and leak no patient data into the DOM"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
