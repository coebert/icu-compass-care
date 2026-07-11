"""
End-to-end (UI) test: a signed-in user WITHOUT clinical access (no admin /
clinician role) sees the "Clinical access required" card instead of any data on
every clinical-history surface:

  1. /patients/history  — saved handover snapshot history
  2. /patients/compare  — compare two saved handover snapshots
  3. /patients/<id>     — the patient record (which contains the History tab);
                          the whole record is access-gated, so the card replaces
                          the record + its History tab rather than leaking data.

Each assertion checks BOTH that the "Clinical access required" card is present
AND that no seeded clinical data leaks into the page.

A throwaway NON-CLINICAL user (no row in user_roles), one handover version, and
one patient are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-user-sees-clinical-access-required-cards.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

CARD_TEXT = "Clinical access required"
PATIENT_NAME = f"NCUI{SUFFIX}"
VERSION_LABEL = f"NonClinical UI {SUFFIX}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_non_clinical_user():
    """Confirmed user with NO row in user_roles => no clinical access."""
    email = f"e2e-nc-cards-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email


def create_patient():
    admission = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 61,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def create_version():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": datetime.now(timezone.utc).date().isoformat(),
            "shift": "am",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "label": VERSION_LABEL,
            "patient_count": 0,
            "snapshot": [],
            "search_text": VERSION_LABEL,
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


def cleanup(version_id, patient_id, user_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


def goto(page, path):
    """Navigate to an in-app route. The ssr:false auth gate + auth-state
    invalidation can abort the first client navigation, so retry once and settle
    on network idle before reading the DOM."""
    for _ in range(2):
        try:
            page.goto(f"{BASE_URL}{path}", wait_until="domcontentloaded")
            break
        except Exception:
            page.wait_for_timeout(500)
    try:
        page.wait_for_load_state("networkidle")
    except Exception:
        pass
    page.wait_for_timeout(1500)


def wait_for_card(page):
    """The card renders once the ['me'] query resolves; poll for it so a slow
    role fetch doesn't race the DOM read."""
    try:
        page.wait_for_function(
            "() => document.body.innerText.includes('Clinical access required')",
            timeout=10000,
        )
    except Exception:
        pass


def main():
    user_id = None
    version_id = None
    patient_id = None
    try:
        user_id, email = create_non_clinical_user()
        version_id = create_version()
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
            # Let the app settle into the authenticated shell first.
            goto(page, "/patients")

            # ---- 1. /patients/history ----
            goto(page, "/patients/history")
            assert "/auth" not in page.url, f"redirected to /auth: {page.url}"
            body = page.evaluate("() => document.body.innerText")
            page.screenshot(path=str(SCREENSHOTS / "nc_cards_history.png"))
            assert CARD_TEXT in body, f"history page missing the card: {body[:400]}"
            assert VERSION_LABEL not in body, "saved version data leaked to non-clinical user"

            # ---- 2. /patients/compare ----
            goto(page, "/patients/compare")
            body = page.evaluate("() => document.body.innerText")
            page.screenshot(path=str(SCREENSHOTS / "nc_cards_compare.png"))
            assert CARD_TEXT in body, f"compare page missing the card: {body[:400]}"
            assert VERSION_LABEL not in body, "version data leaked on compare page"

            # ---- 3. /patients/<id> (the record + its History tab) ----
            goto(page, f"/patients/{patient_id}")
            body = page.evaluate("() => document.body.innerText")
            page.screenshot(path=str(SCREENSHOTS / "nc_cards_patient.png"))
            assert CARD_TEXT in body, f"patient record missing the card: {body[:400]}"
            # No patient clinical data (name) leaks, and the History tab is not
            # exposed as a data view.
            assert PATIENT_NAME not in body, "patient record data leaked to non-clinical user"

            browser.close()

        print(
            "PASS: non-clinical user sees the 'Clinical access required' card "
            "on /patients/history, /patients/compare and the patient record "
            "(History tab), with no clinical data leaking"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(version_id, patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
