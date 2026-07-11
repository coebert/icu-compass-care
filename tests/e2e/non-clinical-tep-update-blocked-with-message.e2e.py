"""
End-to-end test (negative path / UI + RLS): a signed-in user WITHOUT clinical
access cannot change a patient's Treatment Escalation Plan (TEP). The app must
BOTH (a) refuse to present an editable TEP form and show a clear access-required
message, and (b) reject any direct TEP write at the backend so no data changes.

Why this shape: the patient detail route
(src/routes/_authenticated/patients.$patientId.tsx) gates the entire record
behind clinical access. A non-clinical user never sees the Edit button or the
Escalation & resuscitation fields — instead the route renders
<ClinicalAccessRequired> ("Clinical access required" / "You need clinical
access (clinician or admin) to view this patient record and its history.").
That gate is the "clear error message" surfaced to a non-clinical user for this
action; the RLS layer is the authoritative guarantee that no update persists.

TEP is stored on `patients` as:
  - tep_in_place (boolean)
  - tep_details  (text)

Steps:
  1. Seed a patient with concrete TEP values (admin API).
  2. Sign in a throwaway NON-clinical user (no user_roles row).
  3. Open the patient detail page in the browser and assert:
       - the "Clinical access required" message is shown,
       - there is no Edit button / no editable TEP field.
  4. Attempt to write the TEP fields directly via the RLS-enforced Data API and
     assert the attempt is rejected (401/403, or 200/204 affecting 0 rows).
  5. Confirm (admin read) the stored TEP values are byte-for-byte unchanged.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/non-clinical-tep-update-blocked-with-message.e2e.py
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
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"T.E.P.Blocked.{SUFFIX}"
ORIG_TEP_IN_PLACE = True
ORIG_TEP_DETAILS = f"For ward-level care, not for ICU re-admission — {SUFFIX}"
ATTACK_DETAILS = f"TAMPERED escalation text — {SUFFIX}"


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
    # No user_roles row => NO clinical access.
    email = f"e2e-nonclin-tep-{STAMP}@example.com"
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
            "age": 72,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "tep_in_place": ORIG_TEP_IN_PLACE,
            "tep_details": ORIG_TEP_DETAILS,
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


def read_tep_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def assert_unchanged(patient_id, label):
    row = read_tep_admin(patient_id)
    assert row["tep_in_place"] == ORIG_TEP_IN_PLACE, (
        f"[{label}] tep_in_place changed! expected {ORIG_TEP_IN_PLACE}, got {row['tep_in_place']}"
    )
    assert row["tep_details"] == ORIG_TEP_DETAILS, (
        f"[{label}] tep_details changed! expected {ORIG_TEP_DETAILS!r}, got {row['tep_details']!r}"
    )


def attempt_update(patient_id, token, payload, label):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
        headers={**user_headers(token), "Prefer": "return=representation"},
        json=payload,
        timeout=30,
    )
    if r.status_code in (401, 403):
        pass
    elif r.status_code in (200, 204):
        if r.status_code == 200:
            affected = r.json()
            assert affected == [], f"[{label}] non-clinical PATCH affected rows: {affected!r}"
    else:
        raise AssertionError(f"[{label}] unexpected status {r.status_code}: {r.text}")
    assert_unchanged(patient_id, label)


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
    user_id = patient_id = None
    try:
        user_id, email = create_non_clinical_user()
        patient_id = create_patient()
        session = sign_in(email)
        token = session["access_token"]

        assert_unchanged(patient_id, "baseline")

        # ---- (a) UI: non-clinical user sees a clear access-required message ----
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # The clear message that this action/view is not permitted.
            expect(
                page.get_by_text("Clinical access required", exact=False)
            ).to_be_visible(timeout=15000)

            page.screenshot(path=str(SCREENSHOTS / f"nonclin_tep_blocked_{SUFFIX}.png"))

            # There must be no editable TEP surface: no Edit button, and the
            # patient's TEP details string must not be present on the page.
            assert page.get_by_role("button", name="Edit").count() == 0, (
                "non-clinical user should not see an Edit button on the gated record"
            )
            body_text = page.locator("body").inner_text()
            assert ORIG_TEP_DETAILS not in body_text, (
                "TEP details leaked into a gated view for a non-clinical user"
            )
            assert "Escalation" not in body_text or "resuscitation" not in body_text, (
                "escalation/resuscitation edit fields should not render for a non-clinical user"
            )

            browser.close()

        # ---- (b) Backend: direct TEP writes are rejected, nothing persists ----
        attempt_update(
            patient_id, token,
            {"tep_in_place": False, "tep_details": ATTACK_DETAILS},
            "flip-and-rewrite",
        )
        attempt_update(
            patient_id, token,
            {"tep_details": ATTACK_DETAILS},
            "rewrite-details-only",
        )
        attempt_update(
            patient_id, token,
            {"tep_in_place": False, "tep_details": None},
            "clear-tep",
        )

        print(
            "PASS: non-clinical user is shown a clear 'Clinical access required' "
            "message with no editable TEP form, and all direct TEP update "
            "attempts are rejected with no data change"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
