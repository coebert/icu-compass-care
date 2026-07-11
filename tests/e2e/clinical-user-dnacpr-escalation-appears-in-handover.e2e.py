"""
End-to-end test (positive path): a signed-in user WITH clinical access records a
DNACPR decision and treatment-escalation-plan (TEP) details on an admitted
patient, and those values then appear in the patient handover view.

The handover view (src/routes/.../patients.handover-preview.tsx) is fed by the
same `patients` list the Data API returns, filtered to ACTIVE patients
(status `admitted` or `referred`). Its "TEP / DNACPR / NOK" column is rendered
by the `flags()` function in src/lib/handover-columns.ts as:

    DNACPR[: <dnacpr_details>]
    TEP[: <tep_details>]

This test reproduces that exact data path and rendering:

  1. Seeds an `admitted` patient (no DNACPR/TEP yet) via the admin API.
  2. Signs in as a throwaway CLINICIAN user.
  3. Records dnacpr_decision + dnacpr_details and tep_in_place + tep_details
     via the RLS-enforced Data API (as the clinical user would from the UI).
  4. Re-fetches the patient list as that user, filters to the active/handover
     set, renders the handover "flags" string, and asserts both the DNACPR
     decision and the escalation-plan details are present.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/clinical-user-dnacpr-escalation-appears-in-handover.e2e.py
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

PATIENT_NAME = f"H.O.{SUFFIX}"
DNACPR_DETAILS = f"Ward-based ceiling of care — {SUFFIX}"
TEP_DETAILS = f"For ward-level care, not for ICU re-admission — {SUFFIX}"


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


def create_clinical_user():
    email = f"e2e-handover-{STAMP}@example.com"
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
            "age": 77,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
            # Deliberately no DNACPR/TEP yet — the clinician records them below.
            "dnacpr_decision": False,
            "tep_in_place": False,
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


def is_active(patient):
    # Mirrors the handover view's active filter.
    return patient.get("status") in ("admitted", "referred")


def render_flags(p):
    # Faithful reproduction of flags() in src/lib/handover-columns.ts
    parts = []
    if p.get("dnacpr_decision"):
        d = p.get("dnacpr_details")
        parts.append(f"DNACPR: {d}" if d else "DNACPR")
    if p.get("tep_in_place"):
        d = p.get("tep_details")
        parts.append(f"TEP: {d}" if d else "TEP")
    return "\n".join(parts) if parts else "—"


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

        # ---- 1. Clinician records DNACPR decision + escalation-plan details ----
        upd = requests.patch(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers={**user_headers(token), "Prefer": "return=representation"},
            json={
                "dnacpr_decision": True,
                "dnacpr_details": DNACPR_DETAILS,
                "dnacpr_date": datetime.now(timezone.utc).date().isoformat(),
                "tep_in_place": True,
                "tep_details": TEP_DETAILS,
            },
            timeout=30,
        )
        assert upd.status_code in (200, 204), (
            f"clinical DNACPR/TEP update must succeed, got {upd.status_code}: {upd.text}"
        )

        # ---- 2. Fetch the handover data source (patient list) as the user ----
        cols = (
            "id,full_name,status,dnacpr_decision,dnacpr_details,"
            "tep_in_place,tep_details"
        )
        lst = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?select={cols}&limit=1000",
            headers=user_headers(token),
            timeout=30,
        )
        lst.raise_for_status()
        patients = lst.json()

        # The handover view only shows active patients — our seeded patient is
        # admitted, so it must be in the handover set.
        handover_set = [p for p in patients if is_active(p)]
        target = next((p for p in handover_set if p.get("id") == patient_id), None)
        assert target is not None, (
            "recorded patient must appear in the active handover view, "
            f"but was not found among {len(handover_set)} active patients"
        )

        # ---- 3. The handover flags column must show the saved values ----
        flags = render_flags(target)
        assert f"DNACPR: {DNACPR_DETAILS}" in flags, (
            f"DNACPR decision/details missing from handover flags: {flags!r}"
        )
        assert f"TEP: {TEP_DETAILS}" in flags, (
            f"escalation-plan (TEP) details missing from handover flags: {flags!r}"
        )

        print(
            "PASS: clinical user's DNACPR decision and escalation-plan details "
            "appear in the patient handover view"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
