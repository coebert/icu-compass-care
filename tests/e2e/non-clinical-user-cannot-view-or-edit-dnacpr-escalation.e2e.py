"""
End-to-end / RLS enforcement test: a signed-in user WITHOUT clinical access
(no clinician/admin role) must NOT be able to view or edit the DNACPR and
treatment-escalation-plan (TEP) fields on any patient record.

The `patients` table gates every command behind
private.has_clinical_access(auth.uid()):

  - SELECT  => a non-clinical user reads ZERO rows, so DNACPR/TEP fields are
              never disclosed (not even a redacted/empty projection).
  - UPDATE  => a non-clinical user's PATCH affects ZERO rows, so
              dnacpr_decision / dnacpr_details / tep_in_place / tep_details
              cannot be tampered with.

This test:

  1. Seeds a patient (with concrete DNACPR + TEP values) via the admin API.
  2. Signs in as a throwaway NON-CLINICAL user (no user_roles row).
  3. Verifies a targeted SELECT of the DNACPR/TEP columns returns nothing.
  4. Attempts to PATCH those columns and verifies the stored row is UNCHANGED.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-user-cannot-view-or-edit-dnacpr-escalation.e2e.py
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

PATIENT_NAME = f"D.N.{SUFFIX}"
ORIG_DNACPR_DETAILS = f"original-dnacpr-{SUFFIX}"
ORIG_TEP_DETAILS = f"original-tep-{SUFFIX}"
TAMPERED_DNACPR_DETAILS = f"tampered-dnacpr-{SUFFIX}"
TAMPERED_TEP_DETAILS = f"tampered-tep-{SUFFIX}"

SENSITIVE_COLS = "id,dnacpr_decision,dnacpr_details,dnacpr_date,tep_in_place,tep_details"


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
    """Create a confirmed user with NO user_roles row => no clinical access."""
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
    admission = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 72,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
            "dnacpr_decision": True,
            "dnacpr_details": ORIG_DNACPR_DETAILS,
            "dnacpr_date": datetime.now(timezone.utc).date().isoformat(),
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
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


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

        # ---- 1. Non-clinical SELECT of DNACPR/TEP fields must return nothing ----
        # Query by id AND by the whole table to prove no leakage on any path.
        by_id = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
            headers=user_headers(token),
            timeout=30,
        )
        assert by_id.status_code == 200, (
            f"expected 200 for RLS-filtered read, got {by_id.status_code}: {by_id.text}"
        )
        assert by_id.json() == [], (
            f"non-clinical user must not see DNACPR/TEP fields, got: {by_id.text}"
        )

        all_rows = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?select={SENSITIVE_COLS}&limit=1000",
            headers=user_headers(token),
            timeout=30,
        )
        assert all_rows.status_code == 200, (
            f"expected 200 for RLS-filtered list, got {all_rows.status_code}: {all_rows.text}"
        )
        assert not any(row.get("id") == patient_id for row in all_rows.json()), (
            "seeded patient's DNACPR/TEP data leaked into the non-clinical list read"
        )

        # ---- 2. Non-clinical UPDATE of DNACPR/TEP fields must change nothing ----
        upd = requests.patch(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={
                "dnacpr_decision": False,
                "dnacpr_details": TAMPERED_DNACPR_DETAILS,
                "tep_in_place": False,
                "tep_details": TAMPERED_TEP_DETAILS,
            },
            timeout=30,
        )
        # No UPDATE grant for this user => accepted-but-0-rows (200/204) or rejected (401/403).
        assert upd.status_code in (200, 204, 401, 403), (
            f"unexpected status for blocked update: {upd.status_code}: {upd.text}"
        )
        if upd.status_code == 200:
            assert upd.json() == [], (
                f"update must affect 0 rows, but rows were returned: {upd.text}"
            )

        # ---- 3. Confirm (via service role) the stored values are untouched ----
        after = read_patient_admin(patient_id)
        assert len(after) == 1, f"patient row missing after update attempt: {after}"
        row = after[0]
        assert row["dnacpr_decision"] is True, (
            f"dnacpr_decision was tampered with: {row}"
        )
        assert row["dnacpr_details"] == ORIG_DNACPR_DETAILS, (
            f"dnacpr_details was tampered with: {row}"
        )
        assert row["tep_in_place"] is True, f"tep_in_place was tampered with: {row}"
        assert row["tep_details"] == ORIG_TEP_DETAILS, (
            f"tep_details was tampered with: {row}"
        )

        print(
            "PASS: non-clinical user cannot view or edit DNACPR/TEP fields on "
            "patient records (RLS denies read and write)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
