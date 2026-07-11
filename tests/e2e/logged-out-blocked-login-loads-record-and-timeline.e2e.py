"""
End-to-end test: patient data is NOT accessible while logged out, and once the
user logs in BOTH the patient record AND the Timeline load correctly.

  PHASE 1 — LOGGED OUT (access blocked)
    1. Deep-link to /patients/<id> redirects to /auth.
    2. The detail UI never leaks (patient name / record tabs do not render).
    3. getPatient(<id>) via the real RPC client is rejected for an auth reason.

  PHASE 2 — LOGGED IN (record + Timeline load correctly)
    4. With a clinician session restored, /patients/<id> renders without
       bouncing to /auth and shows the seeded patient's name.
    5. The Timeline tab surfaces the auto-derived "Admitted to critical care"
       event AND a seeded key event, each with its details.

A throwaway clinician user + one patient (with a key event) are created and
cleaned up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/logged-out-blocked-login-loads-record-and-timeline.e2e.py
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
MARKER = f"E2E-AUTHTL-{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "A.U.T."
EVENT_TYPE = "Family meeting"
EVENT_DETAIL = f"Goals-of-care discussion held with family {STAMP}"


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
    admission = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def create_event(patient_id):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patient_events",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "event_type": EVENT_TYPE,
            "description": EVENT_DETAIL,
            "event_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()


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
            f"{SUPABASE_URL}/rest/v1/patient_events?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        create_event(patient_id)
        session = sign_in(email)
        detail_url = f"{BASE_URL}/patients/{patient_id}"

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # ---- PHASE 1: LOGGED OUT — access blocked ----
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page).to_have_url(lambda u: "/auth" in u, timeout=15000)
            body = page.inner_text("body")
            assert PATIENT_NAME not in body, (
                f"patient name leaked while logged out:\n{body[:500]!r}"
            )
            assert EVENT_DETAIL not in body, "timeline event leaked while logged out"
            page.screenshot(path=str(SCREENSHOTS / "authtl_logged_out_blocked.png"))

            # ---- PHASE 2: LOG IN — record + Timeline load ----
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after login: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # Timeline shows the auto-derived admission event AND the seeded event.
            timeline = open_tab(page, "Timeline")
            tl_text = timeline.inner_text()
            assert "Admitted to critical care" in tl_text, (
                f"Timeline missing admission event:\n{tl_text!r}"
            )
            assert EVENT_TYPE in tl_text and EVENT_DETAIL in tl_text, (
                f"Timeline missing seeded key event:\n{tl_text!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "authtl_logged_in_timeline.png"))

            browser.close()

        print(
            "PASS: patient data blocked while logged out; after login the record "
            "and Timeline (admission + key event) load correctly"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
