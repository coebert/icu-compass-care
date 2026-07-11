"""
End-to-end test: while UNAUTHENTICATED, neither the patient board (/patients)
nor a patient detail route (/patients/<id>) may leak ANY patient data into the
DOM anywhere on the page.

This is a stricter, content-focused complement to the existing route guards
(patient-auth-guard.e2e.py, patient-detail-auth-guard.e2e.py): rather than only
asserting the redirect to /auth, it seeds one patient whose every human-visible
field carries a unique, unguessable marker string, then — logged out — visits
both routes and scans the ENTIRE rendered DOM (full HTML + visible text +
document.title) to prove not a single marker appears.

What it asserts, with NO session ever restored:
  1. /patients redirects to /auth and no seeded marker appears anywhere in the
     DOM (full outerHTML, body innerText, or <title>).
  2. /patients/<id> redirects to /auth and, likewise, no seeded marker appears
     anywhere in the DOM.
  3. The board record tabs / patient detail chrome never render.

A throwaway patient (rich with markers) is created and removed via the Supabase
admin REST API. No user is ever created — the whole point is the logged-out
view. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patients-logged-out-no-data-leak.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

STAMP = str(int(time.time()))
# Every marker is unique + unguessable so a hit can only come from the seeded
# row, never from static app chrome.
NAME_MARKER = f"Zxq{STAMP}"
HOSPITAL_MARKER = f"HN{STAMP}"
WARD_MARKER = f"WARD{STAMP}"
BED_MARKER = f"BED{STAMP}"
MGMT_MARKER = f"Mgmt{STAMP}"
ADMISSION_MARKER = f"Adm{STAMP}"
NOK_MARKER = f"Kin{STAMP}"
TEP_MARKER = f"Tep{STAMP}"

# All markers that must NEVER appear in a logged-out DOM.
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


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": NAME_MARKER,
            "age": 57,
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


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
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
    # Never restore a session — this visitor is logged out.
    page.goto(url, wait_until="domcontentloaded")
    # The protected subtree redirects unauthenticated users to /auth.
    page.wait_for_url("**/auth", timeout=15000)
    assert page.url.rstrip("/").endswith("/auth"), (
        f"[{label}] expected redirect to /auth, got {page.url}"
    )
    # Give any late render / hydration a beat to (not) leak data.
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)

    # The record chrome must never render.
    assert not page.get_by_role("tab", name="Overview").count(), (
        f"[{label}] patient detail tabs rendered while logged out — UI leaked"
    )

    leaks = find_leaks(page)
    assert not leaks, f"[{label}] patient data leaked into the DOM while logged out: {leaks}"


def main():
    patient_id = None
    try:
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # Establish the origin first (no session written to localStorage).
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Board route ----
            assert_blocked(page, f"{BASE_URL}/patients", "board")
            page.screenshot(path=str(SCREENSHOTS / "loggedout_board_no_leak.png"))

            # ---- 2. Detail route (deep link) ----
            assert_blocked(page, f"{BASE_URL}/patients/{patient_id}", "detail")
            page.screenshot(path=str(SCREENSHOTS / "loggedout_detail_no_leak.png"))

            browser.close()

        print(
            "PASS: logged-out /patients and /patients/<id> redirect to /auth and "
            "leak no patient data into the DOM"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
