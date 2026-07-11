"""
End-to-end / RLS enforcement test (positive path): a signed-in user WITH
clinical access (clinician role) CAN:

  1. READ handover_versions — the SELECT policy allows
     private.has_clinical_access(auth.uid()), so a seeded version is visible.
  2. WRITE patient_field_changes — the INSERT policy allows clinical access, so
     the row is created and then reads back.

This is the mirror of the non-clinical negative tests: it proves the policies
grant access to clinical staff rather than blanket-denying everyone.

A throwaway CLINICIAN user, one handover_versions row, and one
patient_field_changes row are created and cleaned up via the Supabase admin
REST API. Nothing lingers in the dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/clinical-user-can-read-versions-and-write-field-changes.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_ID = None  # set after the patient is seeded (FK target)
PATIENT_NAME = f"C.U.{SUFFIX}"
VERSION_LABEL = f"Clinical read {SUFFIX}"
FIELD_NEW_VALUE = f"true-{SUFFIX}"


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
    email = f"e2e-clinical-{STAMP}@example.com"
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


def create_patient():
    """Seed a real patient so the field-change FK target exists."""
    admission = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 58,
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


def cleanup(version_id, user_id, patient_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )
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
    global PATIENT_ID
    user_id = None
    version_id = None
    patient_id = None
    try:
        user_id, email = create_clinical_user()
        version_id = create_version()
        patient_id = create_patient()
        PATIENT_ID = patient_id
        token = sign_in(email)

        # ---- 1. Clinical READ of handover_versions must return the seeded row ----
        read = requests.get(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}&select=id,label",
            headers=user_headers(token),
            timeout=30,
        )
        assert read.status_code == 200, (
            f"expected 200 reading handover_versions, got {read.status_code}: {read.text}"
        )
        rows = read.json()
        assert any(v.get("id") == version_id for v in rows), (
            f"clinical user must be able to read the seeded handover version, got: {rows}"
        )

        # ---- 2. Clinical INSERT into patient_field_changes must succeed ----
        write = requests.post(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={
                "patient_id": PATIENT_ID,
                "field_name": "age",
                "old_value": "false",
                "new_value": FIELD_NEW_VALUE,
                "changed_by": user_id,
                "changed_by_email": email,
            },
            timeout=30,
        )
        assert write.status_code in (200, 201), (
            "clinical user's patient_field_changes insert must succeed, "
            f"got {write.status_code}: {write.text}"
        )
        created = write.json()
        assert created and created[0].get("new_value") == FIELD_NEW_VALUE, (
            f"created field-change row not returned as expected: {created}"
        )

        # ---- Confirm the row is persisted (read back via service role) ----
        check = requests.get(
            f"{SUPABASE_URL}/rest/v1/patient_field_changes?patient_id=eq.{PATIENT_ID}"
            "&select=id,new_value",
            headers=admin_headers(),
            timeout=30,
        )
        check.raise_for_status()
        persisted = check.json()
        assert len(persisted) == 1 and persisted[0]["new_value"] == FIELD_NEW_VALUE, (
            f"field-change row was not persisted as expected: {persisted}"
        )

        print(
            "PASS: clinical user can read handover_versions and create a "
            "patient_field_changes entry (RLS grants clinical access)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(version_id, user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
