"""
End-to-end governance test for the cross-project partner bridge:

  1. The partner app ONLY ever receives patients an administrator has marked
     "Shared with partner" (patients.shared_with_partner = true). Non-shared
     patients never appear in the bridge patients list.
  2. The encrypted/sensitive fields (DNACPR + investigations) of NON-shared
     patients are never disclosed across the bridge — the investigations
     endpoint scopes strictly to shared patients, and the DNACPR details of a
     non-shared patient never appear in any bridge response.
  3. The local governance flags (shared_with_partner*) are stripped from the
     shared patient payload — they are a local decision, not partner data.

Bridge auth (see src/lib/api-bridge.server.ts):
  actor     = JSON { id, email, role }              -> x-actor header
  message   = `${timestamp}.${actor}.${rawBody}`    (rawBody "" for GET)
  signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) ) -> x-signature
  x-timestamp = unix seconds

Sharing gate (see src/routes/api/public/bridge.patients.ts /
src/routes/api/public/bridge.investigations.ts):
  - GET /patients        => .eq("shared_with_partner", true)
  - GET /investigations  => scoped to sharedPatientIds() only

Steps:
  1. Seed a SHARED patient (shared_with_partner=true) with DNACPR + 1 investigation.
  2. Seed a NON-shared patient with DNACPR + 1 investigation.
     (INSERTing the flag directly is allowed; the admin-only guard trigger only
      fires on UPDATE of shared_with_partner.)
  3. Signed GET /bridge/patients: shared present, non-shared absent, and the
     shared_with_partner* governance fields stripped from the shared payload.
  4. Signed GET /bridge/investigations?patient_id=<shared>: returns the shared
     patient's investigation.
  5. Signed GET /bridge/investigations?patient_id=<non-shared>: returns []; the
     non-shared DNACPR/investigation text never appears in any response body.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HANDOVER_API_SECRET
Run:  python3 tests/e2e/bridge-shared-only-non-shared-dnacpr-investigations-hidden.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BRIDGE_SECRET = os.environ["HANDOVER_API_SECRET"]

BRIDGE = f"{BASE_URL}/api/public/bridge"
STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]

SHARED_NAME = f"Shared {SUFFIX}"
NONSHARED_NAME = f"Private {SUFFIX}"
SHARED_DNACPR = f"shared-dnacpr-{SUFFIX}"
NONSHARED_DNACPR = f"private-dnacpr-{SUFFIX}"
SHARED_FINDING = f"shared-finding-{SUFFIX}"
NONSHARED_FINDING = f"private-finding-{SUFFIX}"

ACTOR = json.dumps(
    {
        "id": "00000000-0000-0000-0000-000000000000",
        "email": f"bridge-share-{SUFFIX}@bridge.test",
        "role": "clinician",
    }
)


def sign(ts, raw_body):
    return hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{ACTOR}.{raw_body}".encode(), hashlib.sha256
    ).hexdigest()


def signed_get(path, params=None):
    ts = str(int(time.time()))
    headers = {
        "x-timestamp": ts,
        "x-actor": ACTOR,
        "x-signature": sign(ts, ""),
    }
    return requests.get(f"{BRIDGE}{path}", headers=headers, params=params, timeout=30)


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_patient(name, dnacpr_details, shared):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "dnacpr_decision": True,
            "dnacpr_details": dnacpr_details,
            "dnacpr_date": datetime.now(timezone.utc).date().isoformat(),
            # INSERT of the flag is allowed (admin-only guard fires on UPDATE only).
            "shared_with_partner": shared,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def create_investigation(patient_id, finding):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "category": "bloods",
            "findings": finding,
            "result_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def cleanup(patient_ids):
    for pid in patient_ids:
        if pid:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{pid}",
                headers=admin_headers(),
                timeout=30,
            )
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
                headers=admin_headers(),
                timeout=30,
            )


def main():
    shared_id = nonshared_id = None
    try:
        shared_id = create_patient(SHARED_NAME, SHARED_DNACPR, True)
        nonshared_id = create_patient(NONSHARED_NAME, NONSHARED_DNACPR, False)
        create_investigation(shared_id, SHARED_FINDING)
        create_investigation(nonshared_id, NONSHARED_FINDING)

        # ---- 1. Patients list: only the shared patient is exposed ----
        pr = signed_get("/patients")
        assert pr.status_code == 200, f"patients GET failed: {pr.status_code}: {pr.text}"
        patients = pr.json().get("patients", [])
        ids = {p.get("id") for p in patients}
        assert shared_id in ids, "shared patient missing from bridge list"
        assert nonshared_id not in ids, "NON-shared patient leaked into bridge list"

        # Non-shared PHI (name + DNACPR) must not appear anywhere in the body.
        assert NONSHARED_NAME not in pr.text, "non-shared patient name leaked"
        assert NONSHARED_DNACPR not in pr.text, "non-shared DNACPR details leaked"

        # Governance flags stripped from the shared payload.
        shared_row = next(p for p in patients if p.get("id") == shared_id)
        for gov in (
            "shared_with_partner",
            "shared_with_partner_at",
            "shared_with_partner_by",
        ):
            assert gov not in shared_row, f"governance field '{gov}' leaked to partner"

        # ---- 2. Investigations for the SHARED patient are available ----
        si = signed_get("/investigations", params={"patient_id": shared_id})
        assert si.status_code == 200, f"shared investigations GET failed: {si.text}"
        shared_invs = si.json().get("investigations", [])
        assert any(
            iv.get("findings") == SHARED_FINDING for iv in shared_invs
        ), "shared patient's investigation not returned"

        # ---- 3. Investigations for the NON-shared patient are hidden ----
        ni = signed_get("/investigations", params={"patient_id": nonshared_id})
        assert ni.status_code == 200, f"non-shared investigations GET failed: {ni.text}"
        assert ni.json().get("investigations", []) == [], (
            "non-shared patient's investigations leaked across the bridge"
        )
        assert NONSHARED_FINDING not in ni.text, "non-shared finding text leaked"

        # ---- 4. Unfiltered investigations pull never includes non-shared data ----
        allinv = signed_get("/investigations")
        assert allinv.status_code == 200, f"investigations GET failed: {allinv.text}"
        assert NONSHARED_FINDING not in allinv.text, (
            "non-shared finding leaked in unfiltered investigations pull"
        )
        assert not any(
            iv.get("patient_id") == nonshared_id
            for iv in allinv.json().get("investigations", [])
        ), "non-shared patient investigations present in unfiltered pull"

        print(
            "PASS: bridge exposes only shared patients; non-shared DNACPR and "
            "investigations remain inaccessible; governance flags stripped"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup([shared_id, nonshared_id])


if __name__ == "__main__":
    sys.exit(main())
