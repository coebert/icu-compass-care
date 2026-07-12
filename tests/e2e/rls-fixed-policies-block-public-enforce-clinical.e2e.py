"""
RLS regression test for the four RLS policy fixes:
  - handover_acknowledgements
  - patient_lines
  - patient_tasks
  - patient_reviews

Each table's read/write is now gated behind private.has_clinical_access(auth.uid())
for the `authenticated` role only (no `public`/anon access, no bare `true`
policies). This test proves, per table, that:

  1. ANONYMOUS (publishable key, NO JWT) can neither READ nor WRITE.
  2. A signed-in NON-CLINICAL user (no user_roles row) can neither READ nor
     WRITE — rows are invisible on read and writes are rejected / affect 0 rows.
  3. A signed-in CLINICAL user (clinician role) CAN read and write
     (positive control, so the policies are not simply "deny everyone").

For every blocked read: PostgREST returns 200 + empty array (RLS filters the
row out) or 401/403, and a seeded unique marker never appears in the body.
For every blocked write: 401/403, or accepted-but-ZERO-rows, and nothing is
persisted (verified via the service role, which bypasses RLS).

Pure REST/API test (no browser). All fixtures created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/rls-fixed-policies-block-public-enforce-clinical.e2e.py
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
MARKER = f"E2E-RLS-{SUFFIX}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def anon_headers():
    # Anonymous Data API request: publishable apikey only, NO user JWT.
    return {"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"}


def user_headers(token):
    # RLS-enforced Data API request: publishable apikey + the user's JWT.
    return {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def create_user(tag, role=None):
    """Create a confirmed user; optionally grant a clinical role."""
    email = f"e2e-rls-{tag}-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    if role:
        rr = requests.post(
            f"{SUPABASE_URL}/rest/v1/user_roles",
            headers=admin_headers(),
            json={"user_id": uid, "role": role},
            timeout=30,
        )
        rr.raise_for_status()
    return uid, email


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": f"R.L.{SUFFIX}",
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_row(table, payload):
    """Seed one row (admin) so blocked reads have something they must NOT see."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=payload,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def count_rows_admin(table, patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}&select=id",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return len(r.json())


failures = []


def check_blocked_read(table, patient_id, headers, actor):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}&select=*",
        headers=headers,
        timeout=30,
    )
    if r.status_code not in (200, 401, 403):
        failures.append(f"[{table}/{actor}] unexpected read status {r.status_code}: {r.text}")
        return
    if r.status_code == 200 and r.json() != []:
        failures.append(f"[{table}/{actor}] read disclosed rows: {r.text}")
    if MARKER in r.text:
        failures.append(f"[{table}/{actor}] marker leaked in read body: {r.text}")


def check_blocked_write(table, payload, headers, actor, patient_id):
    before = count_rows_admin(table, patient_id)
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**headers, "Prefer": "return=representation"},
        json=payload,
        timeout=30,
    )
    if r.status_code not in (200, 201, 401, 403):
        failures.append(f"[{table}/{actor}] unexpected write status {r.status_code}: {r.text}")
    if r.status_code in (200, 201):
        # PostgREST with RLS-blocked INSERT normally errors; a 2xx must at least
        # not have created a row.
        pass
    after = count_rows_admin(table, patient_id)
    if after != before:
        failures.append(f"[{table}/{actor}] write persisted a row despite RLS (rows {before}->{after})")


def check_allowed(table, payload, marker_field, token, actor, patient_id):
    # Clinical user READ must see the seeded row.
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}&select=*",
        headers=user_headers(token),
        timeout=30,
    )
    if r.status_code != 200 or not isinstance(r.json(), list) or len(r.json()) < 1:
        failures.append(f"[{table}/{actor}] clinical read failed: {r.status_code} {r.text}")
    # Clinical user WRITE must succeed.
    w = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**user_headers(token), "Prefer": "return=representation"},
        json=payload,
        timeout=30,
    )
    if w.status_code not in (200, 201):
        failures.append(f"[{table}/{actor}] clinical write failed: {w.status_code} {w.text}")


def main():
    patient_id = None
    nonclin_id = None
    clin_id = None
    try:
        patient_id = create_patient()
        nonclin_id, nonclin_email = create_user("nonclin")
        clin_id, clin_email = create_user("clin", role="clinician")
        nonclin_token = sign_in(nonclin_email)
        clin_token = sign_in(clin_email)

        # (table, seeded row payload, blocked-write payload, clinical-write payload)
        tables = [
            (
                "handover_acknowledgements",
                {"patient_id": patient_id, "shift_key": f"day-{MARKER}", "action": "ack", "note": MARKER},
                {"patient_id": patient_id, "shift_key": f"blk-{MARKER}", "action": "ack", "note": MARKER},
                {"patient_id": patient_id, "shift_key": f"ok-{MARKER}", "action": "ack", "note": MARKER},
            ),
            (
                "patient_lines",
                {"patient_id": patient_id, "device_type": "cvc", "notes": MARKER},
                {"patient_id": patient_id, "device_type": "cvc", "notes": MARKER},
                {"patient_id": patient_id, "device_type": "art_line", "notes": MARKER},
            ),
            (
                "patient_tasks",
                {"patient_id": patient_id, "description": f"seed {MARKER}"},
                {"patient_id": patient_id, "description": f"blk {MARKER}"},
                {"patient_id": patient_id, "description": f"ok {MARKER}"},
            ),
            (
                "patient_reviews",
                {"patient_id": patient_id, "specialty": "micro", "review": MARKER},
                {"patient_id": patient_id, "specialty": "micro", "review": MARKER},
                {"patient_id": patient_id, "specialty": "renal", "review": MARKER},
            ),
        ]

        for table, seed, blk_write, clin_write in tables:
            seed_row(table, seed)

            # 1. Anonymous — no read, no write.
            check_blocked_read(table, patient_id, anon_headers(), "anon")
            check_blocked_write(table, blk_write, anon_headers(), "anon", patient_id)

            # 2. Non-clinical authenticated — no read, no write.
            check_blocked_read(table, patient_id, user_headers(nonclin_token), "nonclin")
            check_blocked_write(table, blk_write, user_headers(nonclin_token), "nonclin", patient_id)

            # 3. Clinical user — read + write allowed (positive control).
            check_allowed(table, clin_write, "note", clin_token, "clin", patient_id)

        assert not failures, "RLS regression failures:\n  - " + "\n  - ".join(failures)

        print(
            "PASS: handover_acknowledgements, patient_lines, patient_tasks and "
            "patient_reviews all block anonymous + non-clinical read/write and "
            "allow clinical read/write"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        # Cascade: deleting the patient removes seeded child rows if FK cascades;
        # delete children explicitly to be safe, then patient + users.
        for table in ("handover_acknowledgements", "patient_lines", "patient_tasks", "patient_reviews"):
            if patient_id:
                requests.delete(
                    f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}",
                    headers=admin_headers(),
                    timeout=30,
                )
        if patient_id:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
                headers=admin_headers(),
                timeout=30,
            )
        for uid in (nonclin_id, clin_id):
            if uid:
                requests.delete(
                    f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
                    headers=admin_headers(),
                    timeout=30,
                )


if __name__ == "__main__":
    sys.exit(main())
