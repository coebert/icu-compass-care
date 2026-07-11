"""
End-to-end / RLS test SUITE (Data API only): querying patient details through
the Data API, DNACPR fields are OMITTED / INACCESSIBLE for a NON-clinical user
but remain fully PRESENT and readable for CLINICAL (clinician) and ADMIN roles.

DNACPR is stored on `patients` as:
  - dnacpr_decision (boolean)
  - dnacpr_details  (text)
  - dnacpr_date     (date)

Every command on `patients` is gated behind private.has_clinical_access
(true for 'admin' and 'clinician', false for a user with no user_roles row):

  - clinical/admin => SELECT returns the row WITH the DNACPR fields.
  - non-clinical   => RLS filters the row out: HTTP 200 with an EMPTY body,
                      so the DNACPR columns are never disclosed (by-id or list).

This is a pure REST/API test (no browser) that hammers the Data API directly
with each role's own JWT.

Role matrix:
  - "admin"      (admin role)      => DNACPR present
  - "clinician"  (clinician role)  => DNACPR present
  - "none"       (no role)         => DNACPR omitted / inaccessible

Steps:
  1. Seed a patient WITH concrete DNACPR values (admin API).
  2. For each role: create + sign in a user, read the patient by id and via the
     whole-table list, and assert the expected disclosure.
  3. Confirm no read ever mutated the stored DNACPR (service-role verify).

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/dnacpr-data-api-visible-clinical-omitted-nonclinical.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
from datetime import datetime, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"API.{SUFFIX}"
DNACPR_DETAILS = f"api-dnacpr-{SUFFIX}"
SENSITIVE_COLS = "id,dnacpr_decision,dnacpr_details,dnacpr_date"

# (label, db_role_or_None, expect_visible)
ROLE_MATRIX = [
    ("admin", "admin", True),
    ("clinician", "clinician", True),
    ("none", None, False),
]


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


def create_user(label, role):
    email = f"e2e-dnacpr-api-{label}-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    if role:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/user_roles",
            headers=admin_headers(),
            json={"user_id": uid, "role": role},
            timeout=30,
        ).raise_for_status()
    return uid, email


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
    return r.json()["access_token"]


def read_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def cleanup(patient_id, user_ids):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    for uid in user_ids:
        if uid:
            requests.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
                headers=admin_headers(),
                timeout=30,
            )


def check_role(label, expect_visible, patient_id, token):
    """Return None on success, or an error string describing the failure."""
    # ---- read by id ----
    by_id = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select={SENSITIVE_COLS}",
        headers=user_headers(token),
        timeout=30,
    )
    # ---- whole-table list read ----
    all_rows = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?select={SENSITIVE_COLS}&limit=1000",
        headers=user_headers(token),
        timeout=30,
    )

    if expect_visible:
        if by_id.status_code != 200:
            return f"[{label}] expected 200 by-id, got {by_id.status_code}: {by_id.text}"
        rows = by_id.json()
        if len(rows) != 1:
            return f"[{label}] expected 1 row by-id, got {rows}"
        row = rows[0]
        if row.get("dnacpr_decision") is not True:
            return f"[{label}] dnacpr_decision not present/true: {row}"
        if row.get("dnacpr_details") != DNACPR_DETAILS:
            return f"[{label}] dnacpr_details missing/mismatched: {row}"
        if DNACPR_DETAILS not in all_rows.text:
            return f"[{label}] DNACPR not present in list read for clinical role"
        return None

    # non-clinical: DNACPR must be omitted / inaccessible
    if by_id.status_code not in (200, 401, 403):
        return f"[{label}] unexpected by-id status: {by_id.status_code}: {by_id.text}"
    if by_id.status_code == 200 and by_id.json() != []:
        return f"[{label}] non-clinical by-id disclosed data: {by_id.text}"
    if DNACPR_DETAILS in by_id.text:
        return f"[{label}] DNACPR details leaked in by-id read"
    if all_rows.status_code == 200 and any(
        r.get("id") == patient_id for r in all_rows.json()
    ):
        return f"[{label}] non-clinical list read disclosed the patient"
    if DNACPR_DETAILS in all_rows.text:
        return f"[{label}] DNACPR details leaked in list read"
    return None


def main():
    patient_id = None
    user_ids = []
    failures = []
    try:
        patient_id = create_patient()
        baseline = read_admin(patient_id)

        for label, role, expect_visible in ROLE_MATRIX:
            uid, email = create_user(label, role)
            user_ids.append(uid)
            token = sign_in(email)
            err = check_role(label, expect_visible, patient_id, token)
            if err:
                failures.append(err)
                print(f"  {err}", file=sys.stderr)
            else:
                print(
                    f"  [{label}] OK "
                    f"({'DNACPR present' if expect_visible else 'DNACPR omitted'})"
                )

        # No read should ever mutate the stored DNACPR.
        after = read_admin(patient_id)
        assert after == baseline, f"DNACPR changed after reads: {after} != {baseline}"

        if failures:
            print(f"FAIL: {len(failures)} role case(s) failed", file=sys.stderr)
            return 1
        print(
            "PASS: Data API omits DNACPR for non-clinical users and exposes it to "
            "clinician/admin roles; stored record unchanged"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_ids)


if __name__ == "__main__":
    sys.exit(main())
