"""
End-to-end test (negative path / RLS enforcement): a signed-in user WITHOUT
clinical access must NOT be able to change a patient's DNACPR / not-for-CPR
decision fields, and the backend must never persist such an attempt.

DNACPR is stored on the `patients` table as two fields:
  - dnacpr_decision  (boolean — the not-for-CPR decision is in place)
  - dnacpr_details   (text    — the recorded ceiling-of-care / decision detail)

Every write to `patients` is gated behind `private.has_clinical_access(auth.uid())`,
so a user with no `user_roles` row (non-clinical) has no permission to update
these fields. This test proves the guarantee end-to-end via the RLS-enforced
Data API:

  1. Seeds a patient with concrete DNACPR values (admin API).
  2. Signs in a throwaway NON-clinical user (no user_roles row).
  3. Attempts three PATCH variants against the DNACPR fields:
       a. flip decision flag + rewrite details
       b. rewrite details only
       c. clear the DNACPR decision entirely
  4. Asserts each attempt is rejected (401/403, or a 200/204 that affects
     0 rows), AND that the stored row is byte-for-byte unchanged afterwards.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-dnacpr-update-not-persisted.e2e.py
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

PATIENT_NAME = f"D.N.R.{SUFFIX}"
ORIG_DNACPR_DECISION = True
ORIG_DNACPR_DETAILS = f"Ward-based ceiling of care, not for CPR — {SUFFIX}"

# Values the non-clinical user will (unsuccessfully) try to write.
ATTACK_DETAILS = f"TAMPERED not-for-CPR text — {SUFFIX}"


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
    email = f"e2e-nonclin-dnacpr-{STAMP}@example.com"
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
            "age": 74,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "dnacpr_decision": ORIG_DNACPR_DECISION,
            "dnacpr_details": ORIG_DNACPR_DETAILS,
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


def read_dnacpr_admin(patient_id):
    # Authoritative read via admin (bypasses RLS) to check what actually persisted.
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=dnacpr_decision,dnacpr_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def assert_unchanged(patient_id, label):
    row = read_dnacpr_admin(patient_id)
    assert row["dnacpr_decision"] == ORIG_DNACPR_DECISION, (
        f"[{label}] dnacpr_decision changed! expected {ORIG_DNACPR_DECISION}, "
        f"got {row['dnacpr_decision']}"
    )
    assert row["dnacpr_details"] == ORIG_DNACPR_DETAILS, (
        f"[{label}] dnacpr_details changed! expected {ORIG_DNACPR_DETAILS!r}, "
        f"got {row['dnacpr_details']!r}"
    )


def attempt_update(patient_id, token, payload, label):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
        headers={**user_headers(token), "Prefer": "return=representation"},
        json=payload,
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
                f"[{label}] non-clinical PATCH affected rows: {affected!r}"
            )
    else:
        raise AssertionError(
            f"[{label}] unexpected status {r.status_code}: {r.text}"
        )
    # Regardless of status, the stored values must be untouched.
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

        # Sanity: seeded values are present before any tampering.
        assert_unchanged(patient_id, "baseline")

        # a. Flip the decision flag + rewrite the details.
        attempt_update(
            patient_id,
            token,
            {"dnacpr_decision": False, "dnacpr_details": ATTACK_DETAILS},
            "flip-and-rewrite",
        )

        # b. Rewrite the details only.
        attempt_update(
            patient_id,
            token,
            {"dnacpr_details": ATTACK_DETAILS},
            "rewrite-details-only",
        )

        # c. Clear the DNACPR decision entirely.
        attempt_update(
            patient_id,
            token,
            {"dnacpr_decision": False, "dnacpr_details": None},
            "clear-decision",
        )

        print(
            "PASS: non-clinical user's DNACPR / not-for-CPR update attempts were "
            "all rejected and never persisted"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
