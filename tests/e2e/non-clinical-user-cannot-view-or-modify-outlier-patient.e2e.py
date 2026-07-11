"""
End-to-end / RLS enforcement test: a signed-in user WITHOUT clinical access
(no admin / clinician role) can NEITHER VIEW NOR MODIFY an outlying-ward
(location_type = 'outlier') patient record, because every policy on
public.patients is scoped to private.has_clinical_access(auth.uid()).

Steps:
  1. Seed an OUTLIER (outlying-ward) patient via the service role.
  2. Create a NON-CLINICAL user (no row in user_roles) and sign in.
  3. VIEW: a RLS-enforced SELECT of the patient returns ZERO rows.
  4. MODIFY: a RLS-enforced UPDATE persists NOTHING — confirmed by re-reading
     the row with the service role and seeing the original value intact.
  5. Control: the seeded outlier patient really exists (service role bypasses
     RLS), ruling out a false pass from the row simply not being there.

A throwaway non-clinical user + one outlier patient are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/non-clinical-user-cannot-view-or-modify-outlier-patient.e2e.py
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

PATIENT_NAME = f"O.W.{SUFFIX}"
ORIGINAL_MGMT = f"Outlier baseline management {SUFFIX}"
ATTEMPTED_MGMT = f"HACKED by non-clinical user {SUFFIX}"


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
    email = f"e2e-nonclinical-outlier-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email


def create_outlier_patient():
    admission = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "outlier",
            "ward": f"Ward 5 (outlier) {SUFFIX}",
            "status": "admitted",
            "admission_date": admission,
            "current_management": ORIGINAL_MGMT,
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


def read_as_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=id,location_type,current_management",
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
        patient_id = create_outlier_patient()
        token = sign_in(email)

        # ---- Control: the outlier patient really exists (service role bypasses RLS)
        ctl = read_as_admin(patient_id)
        assert len(ctl) == 1, "control: seeded outlier patient should exist"
        assert ctl[0]["location_type"] == "outlier", "control: patient should be an outlier"

        # ---- 1. VIEW must return ZERO rows for the non-clinical user ----
        view = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=id,full_name",
            headers=user_headers(token),
            timeout=30,
        )
        assert view.status_code == 200, (
            f"expected 200 from RLS-filtered read, got {view.status_code}: {view.text}"
        )
        assert view.json() == [], (
            f"non-clinical user must not view the outlier patient, got: {view.json()}"
        )

        # ---- 2. MODIFY must persist NOTHING ----
        modify = requests.patch(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={"current_management": ATTEMPTED_MGMT},
            timeout=30,
        )
        # RLS either rejects with an authorization status, or filters the row out
        # so the update affects zero rows (200 + empty representation). Both are
        # acceptable; what matters is that nothing changed.
        if modify.status_code == 200:
            assert modify.json() == [], (
                f"update unexpectedly affected rows for a non-clinical user: {modify.json()}"
            )
        else:
            assert modify.status_code in (401, 403), (
                f"unexpected status modifying outlier patient: {modify.status_code}: {modify.text}"
            )

        # ---- Confirm the record is untouched (read back via service role) ----
        after = read_as_admin(patient_id)
        assert len(after) == 1, "outlier patient disappeared after the update attempt"
        assert after[0]["current_management"] == ORIGINAL_MGMT, (
            "non-clinical user modified the outlier patient despite RLS: "
            f"{after[0]['current_management']!r}"
        )

        print(
            "PASS: non-clinical user cannot view or modify an outlying-ward "
            "(outlier) patient record — RLS enforced"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
