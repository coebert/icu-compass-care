"""
End-to-end / RLS enforcement test (audit-trail immutability): a signed-in user
WITH clinical access (clinician role) can INSERT patient_field_changes, but must
NOT be able to UPDATE or DELETE existing rows. The table has only SELECT and
INSERT policies for `authenticated`; there are no UPDATE or DELETE policies, so
RLS silently filters those writes to zero affected rows — the audit trail is
append-only / immutable.

This test:

  1. Seeds a patient and one patient_field_changes row via the admin API.
  2. Signs in as a throwaway CLINICIAN user.
  3. Confirms the clinical user CAN read the row (SELECT policy).
  4. Attempts an UPDATE (PATCH) as the clinical user and verifies the stored
     row is UNCHANGED afterwards (no UPDATE policy => 0 rows affected).
  5. Attempts a DELETE as the clinical user and verifies the row STILL EXISTS
     afterwards (no DELETE policy => 0 rows affected).

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/clinical-user-cannot-update-or-delete-field-changes.e2e.py
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

PATIENT_NAME = f"I.M.{SUFFIX}"
ORIGINAL_OLD = "false"
ORIGINAL_NEW = f"original-{SUFFIX}"
TAMPERED_NEW = f"tampered-{SUFFIX}"


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
    email = f"e2e-immutable-{STAMP}@example.com"
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


def create_field_change(patient_id, actor_id, actor_email):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patient_field_changes",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "field_name": "age",
            "old_value": ORIGINAL_OLD,
            "new_value": ORIGINAL_NEW,
            "changed_by": actor_id,
            "changed_by_email": actor_email,
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


def read_change_admin(change_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patient_field_changes?id=eq.{change_id}"
        "&select=id,new_value,old_value",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_id, user_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?patient_id=eq.{patient_id}",
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


def main():
    user_id = None
    patient_id = None
    try:
        user_id, email = create_clinical_user()
        patient_id = create_patient()
        change_id = create_field_change(patient_id, user_id, email)
        token = sign_in(email)

        # ---- 1. Clinical user CAN read the existing audit row (SELECT policy) ----
        read = requests.get(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?id=eq.{change_id}"
            "&select=id,new_value",
            headers=user_headers(token),
            timeout=30,
        )
        assert read.status_code == 200, (
            f"expected 200 reading patient_field_changes, got {read.status_code}: {read.text}"
        )
        assert any(row.get("id") == change_id for row in read.json()), (
            f"clinical user must be able to read the seeded audit row, got: {read.json()}"
        )

        # ---- 2. Clinical UPDATE must NOT modify the row (no UPDATE policy) ----
        upd = requests.patch(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?id=eq.{change_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={"new_value": TAMPERED_NEW},
            timeout=30,
        )
        # RLS with no UPDATE policy => request is accepted but affects 0 rows
        # (200/204 with an empty representation), or is outright rejected (403).
        assert upd.status_code in (200, 204, 401, 403), (
            f"unexpected status for blocked update: {upd.status_code}: {upd.text}"
        )
        if upd.status_code == 200:
            assert upd.json() == [], (
                f"update must affect 0 rows, but rows were returned: {upd.text}"
            )

        after_update = read_change_admin(change_id)
        assert len(after_update) == 1, (
            f"row must still exist after blocked update, got: {after_update}"
        )
        assert after_update[0]["new_value"] == ORIGINAL_NEW, (
            "audit row was tampered with! new_value changed from "
            f"{ORIGINAL_NEW!r} to {after_update[0]['new_value']!r}"
        )

        # ---- 3. Clinical DELETE must NOT remove the row (no DELETE policy) ----
        dele = requests.delete(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?id=eq.{change_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            timeout=30,
        )
        assert dele.status_code in (200, 204, 401, 403), (
            f"unexpected status for blocked delete: {dele.status_code}: {dele.text}"
        )
        if dele.status_code == 200:
            assert dele.json() == [], (
                f"delete must affect 0 rows, but rows were returned: {dele.text}"
            )

        after_delete = read_change_admin(change_id)
        assert len(after_delete) == 1 and after_delete[0]["id"] == change_id, (
            f"audit row was deleted! it must remain immutable, got: {after_delete}"
        )
        assert after_delete[0]["new_value"] == ORIGINAL_NEW, (
            f"audit row value changed unexpectedly: {after_delete}"
        )

        print(
            "PASS: clinical user cannot update or delete patient_field_changes "
            "records — the audit trail is immutable (append-only)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
