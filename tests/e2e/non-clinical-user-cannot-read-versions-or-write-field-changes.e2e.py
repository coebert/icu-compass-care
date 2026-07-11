"""
End-to-end / RLS enforcement test: a signed-in user WITHOUT clinical access
(no admin / clinician role) must NOT be able to:

  1. READ handover_versions — the SELECT policy is now scoped to
     private.has_clinical_access(auth.uid()), so a non-clinical user's
     RLS-enforced Data API query returns ZERO rows even though a version exists.
  2. WRITE patient_field_changes — the INSERT policy requires clinical access,
     so a non-clinical user's insert is rejected by RLS.

The test proves BOTH the negative (non-clinical blocked) and, as a control,
that the seeded handover_versions row genuinely exists (readable via the
service role, which bypasses RLS). This rules out a false pass caused by the
row simply not being there.

A throwaway NON-CLINICAL user (created with NO row in user_roles) plus one
handover_versions row are created and cleaned up via the Supabase admin REST
API. Nothing lingers in the dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-user-cannot-read-versions-or-write-field-changes.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
import uuid
from datetime import datetime, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_ID = str(uuid.uuid4())
VERSION_LABEL = f"NonClinical guard {SUFFIX}"


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
    email = f"e2e-nonclinical-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email


def create_version():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": datetime.now(timezone.utc).date().isoformat(),
            "shift": "am",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "label": VERSION_LABEL,
            "patient_count": 0,
            "snapshot": [],
            "search_text": VERSION_LABEL,
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


def cleanup(version_id, user_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )
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
    version_id = None
    try:
        user_id, email = create_non_clinical_user()
        version_id = create_version()
        token = sign_in(email)

        # ---- Control: the seeded version really exists (service role bypasses RLS)
        ctl = requests.get(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}&select=id,label",
            headers=admin_headers(),
            timeout=30,
        )
        ctl.raise_for_status()
        assert len(ctl.json()) == 1, "control: seeded handover version should exist"

        # ---- 1. Non-clinical READ of handover_versions must return ZERO rows ----
        read = requests.get(
            f"{SUPABASE_URL}/rest/v1/handover_versions?select=id,label",
            headers=user_headers(token),
            timeout=30,
        )
        # RLS filters rows silently => 200 with an empty array (not an error).
        assert read.status_code == 200, (
            f"expected 200 from RLS-filtered read, got {read.status_code}: {read.text}"
        )
        rows = read.json()
        assert rows == [], (
            f"non-clinical user must not read any handover_versions, got: {rows}"
        )
        assert not any(v.get("id") == version_id for v in rows), (
            "seeded version leaked to non-clinical user"
        )

        # ---- 2. Non-clinical INSERT into patient_field_changes must be rejected ----
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
        assert write.status_code in (401, 403), (
            "non-clinical user's patient_field_changes insert must be rejected by RLS, "
            f"got status {write.status_code}: {write.text}"
        )

        # ---- Confirm nothing was written ----
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
            "PASS: non-clinical user cannot read handover_versions and cannot "
            "write patient_field_changes (RLS enforced)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(version_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
