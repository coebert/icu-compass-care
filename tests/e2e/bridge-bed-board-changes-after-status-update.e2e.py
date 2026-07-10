"""
End-to-end test: partner polling the public bridge bed board over the real
signed-actor HMAC auth sees the board change after a patient status update.

Scenario (mirrors how the partner app polls the bridge):
  1. Poll  GET /api/public/bridge/beds  -> capture a baseline snapshot and pick
     a currently-FREE known bed slot.
  2. Create an ICU patient (status "admitted") assigned to that free bed via
     POST /api/public/bridge/patients.
  3. Poll the bed board again -> the chosen bed is now OCCUPIED by our patient,
     stats.occupied increased by exactly 1, and the occupant projection carries
     our patient's id/name/status.
  4. Update the patient's status admitted -> discharged via
     POST /api/public/bridge/patients (bridge only shows admitted/referred ICU
     patients on the board).
  5. Poll the bed board a final time -> the chosen bed is FREE again, our
     patient no longer appears anywhere on the board, and stats.occupied is
     back to the baseline.

This proves the bridge bed-board payload is a live view that reacts to clinical
status changes, so a regression that froze occupancy (e.g. dropped status
filter, cached response, missing no-store) fails loudly.

Auth model (see src/lib/api-bridge.server.ts):
  actor     = JSON { id, email, role }              -> x-actor header
  message   = `${timestamp}.${actor}.${rawBody}`    (rawBody "" for GET)
  signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) ) -> x-signature
  x-timestamp = unix seconds (within +/- 300s skew)

Requires (present in the sandbox env):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HANDOVER_API_SECRET

Run:  python3 tests/e2e/bridge-bed-board-changes-after-status-update.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone

import requests

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BRIDGE_SECRET = os.environ["HANDOVER_API_SECRET"]

MARKER = f"E2E-BEDPOLL-{int(time.time())}"
PATIENT_NAME = f"Bed Poll {MARKER}"
BRIDGE = f"{BASE_URL}/api/public/bridge"

ACTOR = json.dumps(
    {
        "id": "00000000-0000-0000-0000-000000000000",
        "email": f"{MARKER.lower()}@bridge.test",
        "role": "clinician",
    }
)


# ---------------------------------------------------------------------------
# Signing helpers
# ---------------------------------------------------------------------------
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


def poll_beds():
    """Simulate one partner poll of the bed board."""
    r = requests.get(f"{BRIDGE}/beds", headers=signed_headers(""), timeout=30)
    if r.status_code != 200:
        raise AssertionError(f"beds poll failed {r.status_code}: {r.text[:200]}")
    return r


def signed_post(path, payload):
    raw = json.dumps(payload)
    return requests.post(
        f"{BRIDGE}{path}", headers=signed_headers(raw), data=raw, timeout=30
    )


# ---------------------------------------------------------------------------
# Cleanup via admin REST API
# ---------------------------------------------------------------------------
def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events?actor_email=eq.{MARKER.lower()}@bridge.test",
        headers=admin_headers(),
        timeout=30,
    )


def check(name, cond, detail=""):
    if not cond:
        raise AssertionError(f"[{name}] FAILED {detail}")
    print(f"  ok: {name}")


def slot_for(board, bed_label):
    for s in board["bed_board"]:
        if s["bed"] == bed_label:
            return s
    return None


def patient_on_board(board, patient_id):
    """True if patient_id appears as an occupant of any bed or in unassigned."""
    for s in board["bed_board"]:
        occ = s.get("occupant")
        if occ and occ.get("id") == patient_id:
            return True
    return any(u.get("id") == patient_id for u in board.get("unassigned", []))


# ---------------------------------------------------------------------------
def main():
    patient_id = None
    try:
        # ---- baseline poll: pick a currently-free known bed ---------------
        r = poll_beds()
        check("baseline beds poll no-store", "no-store" in (r.headers.get("Cache-Control") or ""))
        baseline = r.json()
        check("baseline bed_board is list", isinstance(baseline.get("bed_board"), list))
        check("baseline has beds", len(baseline["bed_board"]) > 0)
        baseline_occupied = baseline["stats"]["occupied"]

        free_slot = next((s for s in baseline["bed_board"] if not s["occupied"]), None)
        check("a free bed exists to test with", free_slot is not None,
              "every bed is occupied; cannot run the transition test")
        target_bed = free_slot["bed"]
        print(f"  using free bed: {target_bed}")

        # ---- create an admitted ICU patient in that free bed -------------
        r = signed_post(
            "/patients",
            {
                "full_name": PATIENT_NAME,
                "age": 61,
                "location_type": "icu",
                "ward": "Radnor Critical Care Unit",
                "bed": target_bed,
                "status": "admitted",
                "current_management": f"Ventilated {MARKER}",
                "admission_date": datetime.now(timezone.utc).date().isoformat(),
            },
        )
        check("patient create 200", r.status_code == 200, f"{r.status_code}: {r.text[:300]}")
        created = r.json()["patient"]
        patient_id = created["id"]
        first_updated_at = created["updated_at"]

        # ---- poll after admission: bed now occupied by our patient -------
        after_admit = poll_beds().json()
        slot = slot_for(after_admit, target_bed)
        check("target bed present after admit", slot is not None)
        check("target bed now occupied", slot["occupied"] is True)
        check(
            "occupant is our patient",
            slot["occupant"] and slot["occupant"]["id"] == patient_id,
            f"occupant={slot.get('occupant')}",
        )
        check("occupant name matches", slot["occupant"]["full_name"] == PATIENT_NAME)
        check("occupant status admitted", slot["occupant"]["status"] == "admitted")
        check(
            "stats.occupied incremented by 1",
            after_admit["stats"]["occupied"] == baseline_occupied + 1,
            f"baseline={baseline_occupied} after={after_admit['stats']['occupied']}",
        )
        check(
            "occupant projection stays slim (no clinical free-text leaked)",
            "current_management" not in slot["occupant"],
        )

        # ---- clinical status update: admitted -> discharged --------------
        r = signed_post(
            "/patients",
            {
                "id": patient_id,
                "full_name": PATIENT_NAME,
                "expected_updated_at": first_updated_at,
                "status": "discharged",
                "discharge_date": datetime.now(timezone.utc).date().isoformat(),
                "discharge_destination": "Ward 5",
            },
        )
        check("status update 200", r.status_code == 200, f"{r.status_code}: {r.text[:300]}")
        check("status is discharged", r.json()["patient"]["status"] == "discharged")

        # ---- poll after discharge: bed free again, patient gone ----------
        after_discharge = poll_beds().json()
        slot = slot_for(after_discharge, target_bed)
        check("target bed present after discharge", slot is not None)
        check("target bed free again", slot["occupied"] is False,
              f"expected free, occupant={slot.get('occupant')}")
        check("target bed occupant cleared", slot["occupant"] is None)
        check(
            "discharged patient absent from whole board",
            not patient_on_board(after_discharge, patient_id),
        )
        check(
            "stats.occupied back to baseline",
            after_discharge["stats"]["occupied"] == baseline_occupied,
            f"baseline={baseline_occupied} after={after_discharge['stats']['occupied']}",
        )

        print("\nPASS: bed board payload reflects the patient status update.")
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    main()
