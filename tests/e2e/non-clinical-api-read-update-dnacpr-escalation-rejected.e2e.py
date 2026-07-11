"""
End-to-end / RLS enforcement test (API only): a signed-in NON-CLINICAL user
(no clinician/admin role) is REJECTED when reading or updating the DNACPR and
treatment-escalation-plan (TEP) fields on a patient via the Data API.

Every command on `patients` is gated behind
private.has_clinical_access(auth.uid()), so for a non-clinical caller:

  - READ (SELECT)  => RLS filters the row out entirely: an HTTP 200 with an
                      EMPTY body. The sensitive DNACPR/TEP columns are never
                      disclosed on any query path (by id or whole-table).
  - WRITE (PATCH)  => no UPDATE is permitted: either an explicit 401/403, or an
                      accepted-but-ZERO-rows response. Either way the request is
                      effectively rejected and the stored row is unchanged.

This is a pure REST/API test (no browser). It complements the UI/RLS coverage
by hammering the Data API directly with the non-clinical user's own JWT.

Steps:
  1. Seed a patient WITH concrete DNACPR + TEP values (admin API).
  2. Sign in as a throwaway NON-CLINICAL user (no user_roles row).
  3. READ: assert both the by-id and whole-table SELECTs disclose nothing.
  4. WRITE: PATCH the DNACPR/TEP columns and assert the attempt is rejected
     (401/403, or 200/204 affecting zero rows).
  5. Confirm (via service role) the stored values are byte-for-byte unchanged.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-api-read-update-dnacpr-escalation-rejected.e2e.py
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

PATIENT_NAME = f"A.P.{SUFFIX}"
ORIG_DNACPR_DETAILS = f"orig-dnacpr-{SUFFIX}"
ORIG_TEP_DETAILS = f"orig-tep-{SUFFIX}"
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
    """Confirmed user with NO user_roles row => no clinical access."""
    email = f"e2e-nonclin-api-dnacpr-{STAMP}@example.com"
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

        # ---- 1. READ by id must disclose nothing ----
        by_id = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
            headers=user_headers(token),
            timeout=30,
        )
        assert by_id.status_code in (200, 401, 403), (
            f"unexpected status for blocked read: {by_id.status_code}: {by_id.text}"
        )
        if by_id.status_code == 200:
            assert by_id.json() == [], (
                f"non-clinical user must not read DNACPR/TEP fields, got: {by_id.text}"
            )
        # No sensitive marker may appear in the raw response, whatever the status.
        assert ORIG_DNACPR_DETAILS not in by_id.text, "DNACPR details leaked in read"
        assert ORIG_TEP_DETAILS not in by_id.text, "TEP details leaked in read"

        # ---- 1b. Whole-table READ must not surface this patient ----
        all_rows = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?select={SENSITIVE_COLS}&limit=1000",
            headers=user_headers(token),
            timeout=30,
        )
        assert all_rows.status_code in (200, 401, 403), (
            f"unexpected status for blocked list read: {all_rows.status_code}: {all_rows.text}"
        )
        if all_rows.status_code == 200:
            assert not any(
                row.get("id") == patient_id for row in all_rows.json()
            ), "seeded patient's DNACPR/TEP data leaked into non-clinical list read"
        assert ORIG_DNACPR_DETAILS not in all_rows.text, "DNACPR details leaked in list"
        assert ORIG_TEP_DETAILS not in all_rows.text, "TEP details leaked in list"

        # ---- 2. UPDATE must be rejected (denied or zero-row no-op) ----
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
        assert upd.status_code in (200, 204, 401, 403), (
            f"unexpected status for blocked update: {upd.status_code}: {upd.text}"
        )
        if upd.status_code == 200:
            assert upd.json() == [], (
                f"update must affect 0 rows, but rows were returned: {upd.text}"
            )

        # ---- 3. Confirm (service role) the stored values are untouched ----
        after = read_patient_admin(patient_id)
        assert len(after) == 1, f"patient row missing after update attempt: {after}"
        row = after[0]
        assert row["dnacpr_decision"] is True, f"dnacpr_decision tampered: {row}"
        assert row["dnacpr_details"] == ORIG_DNACPR_DETAILS, (
            f"dnacpr_details tampered: {row}"
        )
        assert row["tep_in_place"] is True, f"tep_in_place tampered: {row}"
        assert row["tep_details"] == ORIG_TEP_DETAILS, f"tep_details tampered: {row}"

        print(
            "PASS: non-clinical user's API read and update of DNACPR/TEP fields "
            f"were rejected (read status {by_id.status_code}, "
            f"update status {upd.status_code}); stored record unchanged"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
