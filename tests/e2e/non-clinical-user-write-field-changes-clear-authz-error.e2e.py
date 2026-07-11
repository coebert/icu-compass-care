"""
End-to-end / RLS enforcement test: a signed-in user WITHOUT clinical access
(no admin / clinician role) receives a CLEAR AUTHORIZATION ERROR when trying to
write patient field change history (patient_field_changes).

The INSERT policy on patient_field_changes requires
private.has_clinical_access(auth.uid()), so a non-clinical user's RLS-enforced
Data API insert is rejected with:

  - an HTTP authorization status (401/403), and
  - a body that clearly signals an authorization / row-level-security failure
    (PostgREST code 42501: "new row violates row-level security policy").

The test then confirms NOTHING was persisted (verified via the service role,
which bypasses RLS).

A throwaway NON-CLINICAL user (created with NO row in user_roles) is created
and cleaned up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-user-write-field-changes-clear-authz-error.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
import uuid

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
PASSWORD = "Test-Passw0rd-123!"
PATIENT_ID = str(uuid.uuid4())


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
    """Create a confirmed user with NO row in user_roles => no clinical access."""
    email = f"e2e-nonclinical-write-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def cleanup(user_id):
    # Best-effort: remove any field-change rows that somehow slipped through.
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/patient_field_changes?patient_id=eq.{PATIENT_ID}",
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
    try:
        user_id, email = create_non_clinical_user()
        token = sign_in(email)

        # ---- Attempt to write patient field change history as a non-clinical user ----
        write = requests.post(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={
                "patient_id": PATIENT_ID,
                "field_name": "dnacpr_decision",
                "old_value": "false",
                "new_value": "true",
                "changed_by": user_id,
                "changed_by_email": email,
            },
            timeout=30,
        )

        # ---- 1. Must be an authorization status ----
        assert write.status_code in (401, 403), (
            "non-clinical user's patient_field_changes insert must be rejected with "
            f"an authorization status, got {write.status_code}: {write.text}"
        )

        # ---- 2. Must carry a CLEAR authorization / RLS message ----
        body_text = write.text.lower()
        clear_authz = (
            "42501" in body_text
            or "row-level security" in body_text
            or "row level security" in body_text
            or "violates" in body_text
            or "permission denied" in body_text
        )
        assert clear_authz, (
            "expected a clear authorization / row-level-security error message, "
            f"got: {write.text}"
        )

        # ---- 3. Confirm nothing was persisted ----
        check = requests.get(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?patient_id=eq.{PATIENT_ID}&select=id",
            headers=admin_headers(),
            timeout=30,
        )
        check.raise_for_status()
        assert check.json() == [], (
            f"a patient_field_changes row was persisted despite RLS: {check.json()}"
        )

        print(
            "PASS: non-clinical user gets a clear authorization error when writing "
            f"patient field change history (status {write.status_code})"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(user_id)


if __name__ == "__main__":
    sys.exit(main())
