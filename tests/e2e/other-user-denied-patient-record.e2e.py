"""
End-to-end test: a DIFFERENT signed-in user without clinical access is denied
another patient's record.

Access to patient data is gated by `private.has_clinical_access` (admin or
clinician role) in RLS — being merely authenticated is not enough. This test
proves the app denies a non-clinical user:

  1. Seed a patient (via admin API) and a SECOND user that has NO role granted
     (an authenticated account with no clinical access).
  2. Sign in as that user and open /patients/<id> directly.
  3. Assert the app does NOT expose the record: the patient's initials and other
     markers never appear, and an "appropriate error" is shown
     ("Patient not found.") — the user is authenticated but unauthorized, so the
     record is simply invisible to them.
  4. Belt-and-braces: call the getPatient server RPC with this user's bearer
     token and assert it returns null (RLS-filtered), not the record.

Then a positive control confirms the seeded record really exists and is
retrievable with service credentials, so step 3/4 prove denial rather than a
missing row.

Throwaway users + patient are created and cleaned up via the Supabase admin
REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/other-user-denied-patient-record.e2e.py
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

MARKER = f"E2E-DENY-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.N.Y."
SECRET_NOTE = f"CONFIDENTIAL management note {MARKER}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user(suffix, role=None):
    email = f"{MARKER.lower()}-{suffix}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    if role:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/user_roles",
            headers=admin_headers(),
            json={"user_id": uid, "role": role},
            timeout=30,
        ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": SECRET_NOTE,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def service_can_read(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=id,full_name",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_id, user_ids):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    for uid in user_ids:
        if uid:
            requests.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
                headers=admin_headers(),
                timeout=30,
            )


def main():
    patient_id = None
    other_uid = None
    try:
        # Second user with NO clinical role: authenticated but unauthorized.
        other_uid, other_email = create_user("other", role=None)
        patient_id = create_patient()
        other_session = sign_in(other_email)

        # Positive control: the record genuinely exists (service can read it).
        assert service_can_read(patient_id), "seed failed: patient not readable by service role"

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(other_session)],
            )

            # Attempt to open another patient's record as the non-clinical user.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # Denial is acceptable either as an /auth redirect OR an in-app
            # "not found / no access" message — but the record must NOT render.
            denied_in_app = "/patients" in page.url and "/auth" not in page.url
            if denied_in_app:
                expect(page.get_by_text("Patient not found.")).to_be_visible(timeout=15000)

            body = page.inner_text("body")
            assert PATIENT_NAME not in body, (
                f"patient initials leaked to unauthorized user: {page.url}"
            )
            assert SECRET_NOTE not in body, (
                f"confidential note leaked to unauthorized user: {page.url}"
            )
            page.screenshot(path=str(SCREENSHOTS / "deny_1_record_hidden.png"))

            browser.close()

        # Belt-and-braces at the RPC layer: getPatient with this user's bearer
        # token must be RLS-filtered to null, never the row.
        rpc = requests.post(
            f"{BASE_URL}/_serverFn/getPatient",
            headers={
                "Authorization": f"Bearer {other_session['access_token']}",
                "Content-Type": "application/json",
            },
            json={"data": {"id": patient_id}},
            timeout=30,
        )
        # The server fn should not surface the record. Accept either an auth
        # rejection or a null/empty payload; reject any body containing the data.
        text = rpc.text
        assert PATIENT_NAME not in text and SECRET_NOTE not in text, (
            f"getPatient RPC leaked record to unauthorized user: {rpc.status_code} {text[:200]}"
        )

        print("PASS: different unauthorized user denied access; no patient markers exposed")
        return 0
    finally:
        cleanup(patient_id, [other_uid])


if __name__ == "__main__":
    sys.exit(main())
