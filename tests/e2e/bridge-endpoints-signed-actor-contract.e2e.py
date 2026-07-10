"""
End-to-end contract test for EVERY /api/public/bridge/* endpoint.

Goal: exercise the whole cross-project bridge surface using the real
signed-actor HMAC auth so a contract regression (renamed field, dropped
response key, broken auth, wrong status code, missing CORS/no-store) fails
loudly instead of silently breaking the partner integration.

Auth model (see src/lib/api-bridge.server.ts):
  actor     = JSON { id, email, role }              -> x-actor header
  message   = `${timestamp}.${actor}.${rawBody}`    (rawBody "" for GET)
  signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) )  -> x-signature
  x-timestamp = unix seconds (must be within +/- 300s skew)

Every request in this test is signed correctly with the real secret and a
valid clinician/admin actor, so we assert the SUCCESS contract of each
endpoint end-to-end. A throwaway patient (plus one investigation) is created
via the bridge's own POST endpoints and cleaned up afterwards via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Coverage:
  health           GET  (unauth) -> secret configured + patient field keys
  verify-signature GET  (unauth self-test) + POST (validates our signature)
  patients         POST create -> GET list -> GET ?status filter -> POST update
                   + optimistic-concurrency 409 on stale expected_updated_at
  investigations   POST append -> GET ?patient_id filter
  microbiology     GET
  referrals        GET
  beds             GET  (bed_board + stats shape)
  audit            GET
  notifications    GET
  CORS             OPTIONS -> 204 on a representative endpoint
  no-store         Cache-Control on a signed response
  auth guard       a correctly-shaped-but-unsigned GET is rejected 401

Requires (present in the sandbox env):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HANDOVER_API_SECRET

Run:  python3 tests/e2e/bridge-endpoints-signed-actor-contract.e2e.py
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

MARKER = f"E2E-BRIDGE-{int(time.time())}"
PATIENT_NAME = f"Bridge Contract {MARKER}"
BRIDGE = f"{BASE_URL}/api/public/bridge"

ACTOR = json.dumps(
    {
        "id": "00000000-0000-0000-0000-000000000000",
        "email": f"{MARKER.lower()}@bridge.test",
        "role": "clinician",
    }
)


# ----------------------------------------------------------------------------
# Signing helpers
# ----------------------------------------------------------------------------
def sign(ts, raw_body):
    return hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{ACTOR}.{raw_body}".encode(), hashlib.sha256
    ).hexdigest()


def signed_headers(raw_body):
    ts = str(int(time.time()))
    return {
        "Content-Type": "application/json",
        "x-timestamp": ts,
        "x-actor": ACTOR,
        "x-signature": sign(ts, raw_body),
    }


def signed_get(path, params=None):
    return requests.get(
        f"{BRIDGE}{path}", headers=signed_headers(""), params=params, timeout=30
    )


def signed_post(path, payload):
    raw = json.dumps(payload)
    return requests.post(
        f"{BRIDGE}{path}", headers=signed_headers(raw), data=raw, timeout=30
    )


# ----------------------------------------------------------------------------
# Cleanup via admin REST API
# ----------------------------------------------------------------------------
def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    # best-effort sync event cleanup for this actor
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events?actor_email=eq.{MARKER.lower()}@bridge.test",
        headers=admin_headers(),
        timeout=30,
    )


def check(name, cond, detail=""):
    if not cond:
        raise AssertionError(f"[{name}] FAILED {detail}")
    print(f"  ok: {name}")


# ----------------------------------------------------------------------------
def main():
    patient_id = None
    try:
        # ---- health (unauthenticated diagnostic) -------------------------
        r = requests.get(f"{BRIDGE}/health", timeout=30)
        check("health status 200", r.status_code == 200, f"got {r.status_code}")
        h = r.json()
        check("health ok flag", h.get("ok") is True)
        check("health service name", h.get("service") == "bridge")
        check(
            "health secret configured",
            h.get("handover_api_secret_configured") is True,
            "HANDOVER_API_SECRET must be configured for the bridge to work",
        )
        check(
            "health exposes patient field keys",
            isinstance(h.get("patient_field_keys"), list)
            and "full_name" in h["patient_field_keys"]
            and "status" in h["patient_field_keys"],
        )
        check(
            "health never leaks the secret value",
            BRIDGE_SECRET not in json.dumps(h),
        )

        # ---- verify-signature GET (self-test) ----------------------------
        r = requests.get(f"{BRIDGE}/verify-signature", timeout=30)
        check("verify-signature GET 200", r.status_code == 200, f"got {r.status_code}")
        v = r.json()
        check("verify-signature self-test passed", v.get("ok") is True)
        check(
            "verify-signature valid accepted",
            v["checks"]["valid_signature_accepted"] is True,
        )
        check(
            "verify-signature tampered rejected",
            v["checks"]["tampered_signature_rejected"] is True,
        )

        # ---- verify-signature POST (validate OUR signature) --------------
        r = signed_post("/verify-signature", {"probe": MARKER})
        check(
            "verify-signature POST accepts our signature",
            r.status_code == 200,
            f"got {r.status_code}: {r.text[:200]}",
        )
        vp = r.json()
        check("verify-signature POST signature_valid", vp.get("signature_valid") is True)
        check(
            "verify-signature POST echoes actor role",
            vp.get("actor", {}).get("role") == "clinician",
        )

        # ---- auth guard: unsigned request is refused ---------------------
        r = requests.get(f"{BRIDGE}/patients", timeout=30)
        check(
            "unsigned patients GET rejected 401",
            r.status_code == 401,
            f"got {r.status_code}: {r.text[:200]}",
        )

        # ---- patients POST create ----------------------------------------
        r = signed_post(
            "/patients",
            {
                "full_name": PATIENT_NAME,
                "age": 55,
                "location_type": "icu",
                "ward": "Critical Care",
                "bed": f"BR-{MARKER[-4:]}",
                "status": "admitted",
                "current_management": f"Initial management {MARKER}",
                "admission_date": datetime.now(timezone.utc).date().isoformat(),
            },
        )
        check(
            "patients POST create 200",
            r.status_code == 200,
            f"got {r.status_code}: {r.text[:300]}",
        )
        created = r.json().get("patient")
        check("patients POST returns patient", isinstance(created, dict) and created.get("id"))
        patient_id = created["id"]
        check("patients POST persisted name", created["full_name"] == PATIENT_NAME)
        check("patients POST persisted status", created["status"] == "admitted")
        first_updated_at = created["updated_at"]

        # ---- patients GET list -------------------------------------------
        r = signed_get("/patients")
        check("patients GET 200", r.status_code == 200, f"got {r.status_code}")
        plist = r.json().get("patients")
        check("patients GET returns list", isinstance(plist, list))
        check(
            "patients GET includes our patient",
            any(p["id"] == patient_id for p in plist),
        )

        # ---- patients GET ?status filter ---------------------------------
        r = signed_get("/patients", params={"status": "admitted"})
        check("patients GET ?status 200", r.status_code == 200)
        adm = r.json()["patients"]
        check(
            "patients GET ?status only admitted",
            all(p["status"] == "admitted" for p in adm),
        )
        check(
            "patients GET ?status includes our patient",
            any(p["id"] == patient_id for p in adm),
        )

        # ---- patients POST update with correct expected_updated_at -------
        r = signed_post(
            "/patients",
            {
                "id": patient_id,
                "full_name": PATIENT_NAME,
                "expected_updated_at": first_updated_at,
                "current_management": f"Updated management {MARKER}",
            },
        )
        check(
            "patients POST update 200",
            r.status_code == 200,
            f"got {r.status_code}: {r.text[:300]}",
        )
        updated = r.json()["patient"]
        check(
            "patients POST update applied",
            updated["current_management"] == f"Updated management {MARKER}",
        )
        check(
            "patients POST update bumped updated_at",
            updated["updated_at"] != first_updated_at,
        )

        # ---- optimistic concurrency: stale expected_updated_at -> 409 ----
        r = signed_post(
            "/patients",
            {
                "id": patient_id,
                "full_name": PATIENT_NAME,
                "expected_updated_at": first_updated_at,  # now stale
                "current_management": "Should be rejected as a stale write",
            },
        )
        check(
            "patients POST stale write -> 409",
            r.status_code == 409,
            f"got {r.status_code}: {r.text[:200]}",
        )
        check("patients 409 body flags conflict", r.json().get("error") == "conflict")

        # ---- investigations POST append ----------------------------------
        r = signed_post(
            "/investigations",
            {
                "patient_id": patient_id,
                "category": "Bloods",
                "findings": f"Hb 120, WCC 8.2 {MARKER}",
                "result_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        check(
            "investigations POST 200",
            r.status_code == 200,
            f"got {r.status_code}: {r.text[:300]}",
        )
        inv = r.json().get("investigation")
        check("investigations POST returns row", isinstance(inv, dict) and inv.get("id"))

        # ---- investigations GET ?patient_id filter -----------------------
        r = signed_get("/investigations", params={"patient_id": patient_id})
        check("investigations GET 200", r.status_code == 200)
        ilist = r.json().get("investigations")
        check("investigations GET returns list", isinstance(ilist, list))
        check(
            "investigations GET filtered to our patient",
            len(ilist) >= 1 and all(i["patient_id"] == patient_id for i in ilist),
        )
        check(
            "investigations GET has our finding",
            any(MARKER in (i.get("findings") or "") for i in ilist),
        )

        # ---- read-only entity endpoints (shape contract) -----------------
        for path, key in [
            ("/microbiology", "microbiology"),
            ("/referrals", "referrals"),
            ("/audit", "audit_log"),
            ("/notifications", "notifications"),
        ]:
            r = signed_get(path)
            check(f"{path} GET 200", r.status_code == 200, f"got {r.status_code}")
            body = r.json()
            check(f"{path} returns '{key}' array", isinstance(body.get(key), list))

        # ---- beds board contract -----------------------------------------
        r = signed_get("/beds")
        check("beds GET 200", r.status_code == 200, f"got {r.status_code}")
        beds = r.json()
        check("beds unit label", beds.get("unit") == "Radnor Critical Care Unit")
        check("beds bed_board is list", isinstance(beds.get("bed_board"), list))
        check(
            "beds stats shape",
            all(
                k in beds.get("stats", {})
                for k in ("total_beds", "occupied", "available", "unassigned")
            ),
        )
        check("beds side_rooms is list", isinstance(beds.get("side_rooms"), list))
        check("beds unassigned is list", isinstance(beds.get("unassigned"), list))

        # ---- CORS preflight ----------------------------------------------
        r = requests.options(f"{BRIDGE}/patients", timeout=30)
        check("OPTIONS preflight 204", r.status_code == 204, f"got {r.status_code}")
        check(
            "OPTIONS exposes CORS origin",
            r.headers.get("Access-Control-Allow-Origin") == "*",
        )

        # ---- no-store on signed responses --------------------------------
        r = signed_get("/patients")
        cc = (r.headers.get("Cache-Control") or "").lower()
        check(
            "signed responses are no-store",
            "no-store" in cc,
            f"Cache-Control was: {cc!r}",
        )

        print("\nALL BRIDGE ENDPOINT CONTRACT CHECKS PASSED")
        return 0
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
