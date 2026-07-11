"""
End-to-end security test (UI + API): after successfully logging in, a
NON-CLINICAL user (no clinician/admin role) still cannot ACCESS a patient's
DNACPR data — neither by navigating directly to the patient URL, nor by
hammering the Data API with their own JWT. The sensitive (encrypted-at-rest)
DNACPR fields are never disclosed and remain byte-for-byte unchanged.

DNACPR is stored on `patients` as:
  - dnacpr_decision (boolean)
  - dnacpr_details  (text)
  - dnacpr_date     (date)

Every command on `patients` is gated behind
private.has_clinical_access(auth.uid()). A logged-in non-clinical caller:

  UI  : direct navigation to /patients/<id> loads (NOT redirected to /auth,
        proving the user is authenticated) but shows
        <ClinicalAccessRequired> ("Clinical access required"); the DNACPR
        details text never appears in the rendered DOM.
  API : SELECT => RLS filters the row out (HTTP 200 empty body); the
        DNACPR columns are never disclosed on by-id or whole-table reads.

Steps:
  1. Seed a patient WITH concrete DNACPR values (admin API).
  2. Create + sign in a throwaway NON-CLINICAL user (no user_roles row).
  3. API: assert by-id and whole-table reads disclose nothing.
  4. UI: restore the session, navigate directly to /patients/<id>, assert the
     access-required gate is shown and the DNACPR details are absent from the DOM.
  5. Confirm (via service role) the DNACPR fields are unchanged.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/non-clinical-cannot-access-dnacpr-url-or-api.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone
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
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"D.U.{SUFFIX}"
DNACPR_DETAILS = f"secret-dnacpr-{SUFFIX}"

SENSITIVE_COLS = "id,dnacpr_decision,dnacpr_details,dnacpr_date"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def user_headers(token):
    return {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def create_non_clinical_user():
    email = f"e2e-nonclin-dnacpr-access-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "3",
            "status": "admitted",
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_DETAILS,
            "dnacpr_date": datetime.now(timezone.utc).date().isoformat(),
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


def read_dnacpr_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def restore_session(page, session):
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [STORAGE_KEY, json.dumps(session)],
    )


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
    user_id = None
    patient_id = None
    try:
        user_id, email = create_non_clinical_user()
        patient_id = create_patient()
        session = sign_in(email)
        token = session["access_token"]

        baseline = read_dnacpr_admin(patient_id)
        assert baseline["dnacpr_decision"] is True
        assert baseline["dnacpr_details"] == DNACPR_DETAILS

        # ---- (A) API: direct Data API reads disclose nothing ----
        by_id = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
            headers=user_headers(token),
            timeout=30,
        )
        assert by_id.status_code in (200, 401, 403), (
            f"unexpected by-id read status: {by_id.status_code}: {by_id.text}"
        )
        if by_id.status_code == 200:
            assert by_id.json() == [], f"by-id read leaked DNACPR: {by_id.text}"
        assert DNACPR_DETAILS not in by_id.text, "DNACPR details leaked in by-id read"

        all_rows = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?select={SENSITIVE_COLS}&limit=1000",
            headers=user_headers(token),
            timeout=30,
        )
        assert all_rows.status_code in (200, 401, 403), (
            f"unexpected list read status: {all_rows.status_code}: {all_rows.text}"
        )
        if all_rows.status_code == 200:
            assert not any(
                row.get("id") == patient_id for row in all_rows.json()
            ), "seeded patient DNACPR leaked into non-clinical list read"
        assert DNACPR_DETAILS not in all_rows.text, "DNACPR details leaked in list read"

        # ---- (B) UI: direct URL navigation while authenticated ----
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = ctx.new_page()
            restore_session(page, session)
            page.goto(
                f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded"
            )

            # Authenticated: not bounced to the sign-in page.
            assert "/auth" not in page.url, (
                f"authenticated non-clinical user redirected to /auth: {page.url}"
            )

            # Clinical gate shown; DNACPR data never rendered.
            expect(
                page.get_by_text("Clinical access required", exact=False)
            ).to_be_visible(timeout=15000)
            page.wait_for_timeout(1000)
            body_text = page.inner_text("body")
            assert DNACPR_DETAILS not in body_text, (
                "DNACPR details leaked into the rendered page for a non-clinical user"
            )
            assert page.get_by_role("button", name="Edit").count() == 0, (
                "non-clinical user must not see an Edit button"
            )
            page.screenshot(
                path=str(SCREENSHOTS / f"nonclin_dnacpr_url_gated_{SUFFIX}.png")
            )
            ctx.close()
            browser.close()

        # ---- (C) Confirm the encrypted DNACPR fields are unchanged ----
        after = read_dnacpr_admin(patient_id)
        assert after == baseline, f"DNACPR fields changed: {after} != {baseline}"

        print(
            "PASS: authenticated non-clinical user cannot access DNACPR data via "
            f"direct URL (gated) or API (read status {by_id.status_code}); "
            "encrypted fields unchanged"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
