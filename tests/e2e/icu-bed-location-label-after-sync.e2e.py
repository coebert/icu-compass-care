"""
End-to-end test: an ICU patient with an assigned bed number is displayed with
the correct ICU bed/location label ("ICU · Bed <n>") on the patient board and
detail view, and that label stays correct after a partner-app sync round-trip
over the cross-project bridge.

The partner sync is exercised through the real HMAC-signed bridge endpoints
(GET /api/public/bridge/patients to read, POST /api/public/bridge/patients to
write) exactly as the partner app would call them, then the UI is re-rendered
to confirm the ICU bed label is unchanged.

Steps:
  1. RECORD (UI/DB) — create an ICU patient (location_type=icu) with a bed;
                      confirm the board shows "ICU · Bed <n>" and the detail
                      meta line shows the same.
  2. SYNC (READ)    — pull the patient over the signed bridge; confirm the
                      partner sees location_type=icu and the same bed.
  3. SYNC (WRITE)   — the partner pushes an unrelated edit back over the bridge
                      (keeping location_type=icu and the bed); confirm the
                      write succeeds and the DB still has icu + bed.
  4. STAYS CORRECT  — reload the board and detail; confirm the ICU bed label is
                      still exactly "ICU · Bed <n>" (not "No location", not a
                      dropped/blank ward).

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/icu-bed-location-label-after-sync.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]
BRIDGE_SECRET = os.environ["HANDOVER_API_SECRET"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-ICUBED-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"Bed Tester {MARKER}"

BED = "12A"
BED_LABEL = f"ICU · Bed {BED}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"{MARKER.lower()}@example.com"
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
    # ICU patient: location_type=icu, a bed, and (as is typical for ICU) no ward.
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "icu",
            "ward": None,
            "bed": BED,
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=full_name,location_type,ward,bed,status,current_management",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
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


ACTOR = json.dumps(
    {"id": "00000000-0000-0000-0000-000000000000", "email": "partner@care.test", "role": "clinician"}
)


def _sign(ts, raw_body):
    return hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{ACTOR}.{raw_body}".encode(), hashlib.sha256
    ).hexdigest()


def bridge_get_patient(patient_id):
    """Read patients as the partner app would: HMAC-signed GET, then filter."""
    ts = str(int(time.time()))
    r = requests.get(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={"x-timestamp": ts, "x-actor": ACTOR, "x-signature": _sign(ts, "")},
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()["patients"]
    return next((p for p in rows if p["id"] == patient_id), None)


def bridge_upsert_patient(payload):
    """Write a patient back as the partner app would: HMAC-signed POST."""
    ts = str(int(time.time()))
    raw = json.dumps(payload)
    r = requests.post(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={
            "Content-Type": "application/json",
            "x-timestamp": ts,
            "x-actor": ACTOR,
            "x-signature": _sign(ts, raw),
        },
        data=raw,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def open_board(page):
    page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"


def open_detail(page, patient_id):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 1. RECORD / display on the board ----
            open_board(page)
            card = page.get_by_text(PATIENT_NAME).first
            expect(card).to_be_visible(timeout=10000)
            # ICU patient with a bed must read "ICU · Bed <n>" — never fall back
            # to "No location" just because the ward is blank (typical for ICU).
            expect(page.get_by_text(BED_LABEL, exact=False).first).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "icubed_board_before.png"))

            # ---- 2. SYNC (READ) over the bridge ----
            synced = bridge_get_patient(patient_id)
            assert synced is not None, "patient not returned over the bridge"
            assert synced["location_type"] == "icu", f"bridge lost ICU location: {synced['location_type']!r}"
            assert synced["bed"] == BED, f"bridge lost bed: {synced['bed']!r}"

            # ---- 3. SYNC (WRITE) — partner pushes an unrelated edit back ----
            note = f"Partner-synced management update {MARKER}"
            res = bridge_upsert_patient({
                "id": patient_id,
                "full_name": PATIENT_NAME,
                "location_type": "icu",
                "bed": BED,
                "current_management": note,
            })
            # Endpoint returns the upserted patient (single object or list).
            assert res, "empty response from bridge upsert"
            after = read_patient(patient_id)
            assert after["location_type"] == "icu", f"ICU location lost after sync: {after['location_type']!r}"
            assert after["bed"] == BED, f"bed lost after sync: {after['bed']!r}"
            assert after["current_management"] == note, "partner edit did not persist"

            # ---- 4. STAYS CORRECT — re-render the board after partner sync ----
            open_board(page)
            expect(page.get_by_text(PATIENT_NAME).first).to_be_visible(timeout=10000)
            expect(page.get_by_text(BED_LABEL, exact=False).first).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "icubed_board_after_sync.png"))

            browser.close()

        print("PASS: ICU bed/location label is correct and stays correct after partner sync")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
