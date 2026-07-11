"""
End-to-end test (negative path / RLS enforcement): a signed-in user WITHOUT
clinical access must NOT be able to change a patient's clinical status
(the lifecycle field: referred / admitted / discharged / died), and the backend
must never persist such a change.

The `patients.status` column drives the patient's clinical lifecycle. Moving a
patient to `discharged` or `died` (or back to `admitted`) is a clinical action;
every write to `patients` is gated behind
`private.has_clinical_access(auth.uid())`, so a user with no `user_roles` row
(non-clinical) has no permission to change status.

This test proves the guarantee end-to-end via the RLS-enforced Data API:

  1. Seeds an `admitted` patient (admin API).
  2. Signs in a throwaway NON-clinical user (no user_roles row).
  3. Attempts several status changes as that user:
       a. admitted -> discharged
       b. admitted -> died
       c. admitted -> referred
  4. Asserts each attempt is rejected (401/403, or a 200/204 that affects
     0 rows), AND that the stored status is unchanged (still `admitted`).

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-status-change-rejected.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"S.T.S.{SUFFIX}"
ORIG_STATUS = "admitted"


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
    # No user_roles row is created => this user has NO clinical access.
    email = f"e2e-nonclin-status-{STAMP}@example.com"
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
            "age": 65,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": ORIG_STATUS,
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


def read_status_admin(patient_id):
    # Authoritative read via admin (bypasses RLS) to see what actually persisted.
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=status",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["status"]


def assert_unchanged(patient_id, label):
    status = read_status_admin(patient_id)
    assert status == ORIG_STATUS, (
        f"[{label}] status changed! expected {ORIG_STATUS!r}, got {status!r}"
    )


def attempt_status_change(patient_id, token, new_status, label):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
        headers={**user_headers(token), "Prefer": "return=representation"},
        json={"status": new_status},
        timeout=30,
    )
    # Rejected outright (401/403) is fine. A 200/204 is only acceptable if RLS
    # matched zero rows (i.e. nothing was actually updated).
    if r.status_code in (401, 403):
        pass
    elif r.status_code in (200, 204):
        if r.status_code == 200:
            affected = r.json()
            assert affected == [], (
                f"[{label}] non-clinical status PATCH affected rows: {affected!r}"
            )
    else:
        raise AssertionError(
            f"[{label}] unexpected status {r.status_code}: {r.text}"
        )
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
    user_id = None
    patient_id = None
    try:
        user_id, email = create_non_clinical_user()
        patient_id = create_patient()
        token = sign_in(email)

        # Sanity: seeded status is present before any tampering.
        assert_unchanged(patient_id, "baseline")

        # a. Discharge the patient.
        attempt_status_change(patient_id, token, "discharged", "to-discharged")

        # b. Mark the patient as died.
        attempt_status_change(patient_id, token, "died", "to-died")

        # c. Move the patient back to referred.
        attempt_status_change(patient_id, token, "referred", "to-referred")

        print(
            "PASS: non-clinical user's patient status-change attempts were all "
            "rejected and never persisted (status stayed 'admitted')"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
