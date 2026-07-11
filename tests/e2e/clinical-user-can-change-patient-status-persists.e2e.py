"""
End-to-end / RLS enforcement test (positive path): a signed-in user WITH
clinical access (clinician role) CAN change a patient's status from `admitted`
to `discharged` (with a discharge date + destination), and the update PERSISTS.

"Persists after refresh" is verified the same way a browser refresh would see
it: after the clinical user's PATCH, the row is re-fetched fresh from the server
(a) again through the RLS-enforced Data API as the same user, and
(b) independently via the service role — both must reflect the new status,
discharge_date, and discharge_destination.

This test:

  1. Seeds an `admitted` patient via the admin API.
  2. Signs in as a throwaway CLINICIAN user.
  3. PATCHes status -> discharged with discharge_date + discharge_destination.
  4. Re-reads the row (user + admin) and asserts the change persisted.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/clinical-user-can-change-patient-status-persists.e2e.py
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

PATIENT_NAME = f"S.C.{SUFFIX}"
DISCHARGE_DESTINATION = f"Ward 5 — {SUFFIX}"
DISCHARGE_DATE = datetime.now(timezone.utc).date().isoformat()


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


def create_clinical_user():
    """Create a confirmed user WITH a clinician role => clinical access."""
    email = f"e2e-status-{STAMP}@example.com"
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
    admission = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
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


SELECT_COLS = "id,status,discharge_date,discharge_destination"


def read_patient(patient_id, headers):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SELECT_COLS}",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def assert_discharged(rows, who):
    assert len(rows) == 1, f"{who}: expected exactly one patient row, got: {rows}"
    row = rows[0]
    assert row["status"] == "discharged", (
        f"{who}: status did not persist as discharged: {row}"
    )
    assert row["discharge_date"] == DISCHARGE_DATE, (
        f"{who}: discharge_date did not persist: {row}"
    )
    assert row["discharge_destination"] == DISCHARGE_DESTINATION, (
        f"{who}: discharge_destination did not persist: {row}"
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
        user_id, email = create_clinical_user()
        patient_id = create_patient()
        token = sign_in(email)

        # ---- 0. Sanity: clinical user reads the patient as `admitted` ----
        before = read_patient(patient_id, user_headers(token))
        assert len(before) == 1 and before[0]["status"] == "admitted", (
            f"expected seeded patient to read as admitted, got: {before}"
        )

        # ---- 1. Clinical UPDATE: admitted -> discharged (+ destination) ----
        upd = requests.patch(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={
                "status": "discharged",
                "discharge_date": DISCHARGE_DATE,
                "discharge_destination": DISCHARGE_DESTINATION,
            },
            timeout=30,
        )
        assert upd.status_code in (200, 204), (
            f"clinical status update must succeed, got {upd.status_code}: {upd.text}"
        )
        if upd.status_code == 200:
            assert_discharged(upd.json(), "update response")

        # ---- 2. "After refresh": re-fetch fresh as the same user ----
        after_user = read_patient(patient_id, user_headers(token))
        assert_discharged(after_user, "user refetch")

        # ---- 3. Independent confirmation via service role ----
        after_admin = read_patient(patient_id, admin_headers())
        assert_discharged(after_admin, "admin refetch")

        print(
            "PASS: clinical user changed patient status admitted -> discharged "
            "with destination, and the update persists after refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
