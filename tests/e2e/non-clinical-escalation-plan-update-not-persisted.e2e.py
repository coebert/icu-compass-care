"""
End-to-end / RLS enforcement test (API only): a signed-in NON-CLINICAL user
(no clinician/admin role) attempts to change a patient's treatment escalation
plan (TEP) fields, and the backend does NOT persist any of the attempted
updates.

The "escalation plan" in this app is the Treatment Escalation Plan, stored on
`patients` as:
  - tep_in_place  (boolean)  -- whether a TEP / ceiling-of-care decision exists
  - tep_details   (text)     -- the ceiling-of-care / escalation decision text

Every command on `patients` is gated behind private.has_clinical_access(auth.uid()),
so for a non-clinical caller an UPDATE is never permitted: PostgREST returns
either an explicit 401/403, or an accepted-but-ZERO-rows response. Either way
the attempt is effectively rejected and the stored row is unchanged.

Steps:
  1. Seed a patient WITH a concrete escalation plan (admin API).
  2. Sign in as a throwaway NON-CLINICAL user (no user_roles row).
  3. Attempt several PATCH variants against the TEP fields (flip the flag,
     rewrite the details, and clear them entirely).
  4. Assert each attempt is rejected (401/403, or 200/204 affecting zero rows).
  5. Confirm (via service role) the stored escalation plan is byte-for-byte
     unchanged after every attempt.

Pure REST/API test (no browser). All fixtures created and cleaned up via the
Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-escalation-plan-update-not-persisted.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"E.P.{SUFFIX}"
ORIG_TEP_DETAILS = f"orig-escalation-plan-{SUFFIX}"
TAMPERED_TEP_DETAILS = f"tampered-escalation-plan-{SUFFIX}"

ESCALATION_COLS = "id,tep_in_place,tep_details"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def user_headers(token):
    # RLS-enforced Data API request: publishable apikey + the user's JWT.
    return {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def create_non_clinical_user():
    """Confirmed user with NO user_roles row => no clinical access."""
    email = f"e2e-nonclin-escalation-{STAMP}@example.com"
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
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
            "tep_in_place": True,
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
    return r.json()["access_token"]


def read_patient_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={ESCALATION_COLS}",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def assert_unchanged(patient_id, context):
    after = read_patient_admin(patient_id)
    assert len(after) == 1, f"[{context}] patient row missing: {after}"
    row = after[0]
    assert row["tep_in_place"] is True, f"[{context}] tep_in_place tampered: {row}"
    assert row["tep_details"] == ORIG_TEP_DETAILS, (
        f"[{context}] tep_details tampered: {row}"
    )


def attempt_update(patient_id, token, payload, context):
    upd = requests.patch(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
        headers={**user_headers(token), "Prefer": "return=representation"},
        json=payload,
        timeout=30,
    )
    assert upd.status_code in (200, 204, 401, 403), (
        f"[{context}] unexpected status for blocked update: "
        f"{upd.status_code}: {upd.text}"
    )
    if upd.status_code == 200:
        assert upd.json() == [], (
            f"[{context}] update must affect 0 rows, but rows returned: {upd.text}"
        )
    # Tampered marker must never be echoed back by the API.
    assert TAMPERED_TEP_DETAILS not in upd.text, (
        f"[{context}] escalation plan write appears to have been accepted: {upd.text}"
    )
    return upd.status_code


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
        token = sign_in(email)

        # Several distinct escalation-plan tampering attempts. Each must be
        # rejected and must leave the stored plan untouched.
        attempts = [
            ("flip flag + rewrite details", {
                "tep_in_place": False,
                "tep_details": TAMPERED_TEP_DETAILS,
            }),
            ("rewrite details only", {
                "tep_details": TAMPERED_TEP_DETAILS,
            }),
            ("clear the escalation plan", {
                "tep_in_place": False,
                "tep_details": None,
            }),
        ]

        statuses = []
        for context, payload in attempts:
            status = attempt_update(patient_id, token, payload, context)
            statuses.append(f"{context}={status}")
            # Verify persistence is unchanged after EACH attempt.
            assert_unchanged(patient_id, context)

        print(
            "PASS: non-clinical user's escalation-plan (TEP) updates were all "
            f"rejected and never persisted ({'; '.join(statuses)}); "
            "stored escalation plan unchanged"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
