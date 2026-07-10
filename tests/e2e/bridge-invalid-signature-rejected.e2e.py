"""
End-to-end security test: a partner sync attempt carrying an INVALID HMAC
signature is rejected, no patient data is mutated, and the UI surfaces an
appropriate "sync failed" error.

Two halves, both exercising real app surfaces:

  A. REJECTION (server) — POST a plausible patient update to the real inbound
     bridge endpoint (/api/public/bridge/patients) but with a tampered HMAC
     signature. The endpoint must answer 401 "Invalid signature", and the
     patient row in the database must be byte-for-byte unchanged (updated_at,
     name and clinical fields identical). A GET with a bad signature is also
     rejected, proving reads are gated too.

  B. UI ERROR (client) — a rejected/failed sync is recorded in
     bridge_sync_events exactly as the app's logSyncError() writes it
     (status=error with an "Invalid signature" message). The global sync-status
     badge in the authenticated header must then read "Last sync failed" and
     its tooltip must surface the invalid-signature detail.

The sync-status badge reads from public.bridge_sync_events, whose SELECT policy
is admin-only, so the test user is granted the 'admin' role. The throwaway
user, patient and sync events are created and removed via the Supabase admin
REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/bridge-invalid-signature-rejected.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
import json
import os
import re
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

MARKER = f"E2E-BADSIG-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"Signature Guard {MARKER}"
SENTINEL_MGMT = f"Original management — must not change {MARKER}"
ATTACKER_MGMT = f"TAMPERED via forged sync {MARKER}"
SYNC_ERR_MSG = f"Invalid signature — partner sync rejected {MARKER}"

ACTOR = json.dumps(
    {"id": "00000000-0000-0000-0000-000000000000", "email": "attacker@evil.test", "role": "clinician"}
)


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
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
        json={"user_id": uid, "role": "admin"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 60,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": SENTINEL_MGMT,
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=full_name,current_management,status,updated_at",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def insert_sync_error(message):
    """Mirror the app's logSyncError() write for a rejected sync."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "direction": "push",
            "entity": "patients",
            "record_count": 0,
            "actor_role": "admin",
            "actor_email": f"{MARKER.lower()}@example.com",
            "status": "error",
            "error_message": message,
            "created_at": datetime.now(timezone.utc).isoformat(),
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
    return r.json()


def cleanup(patient_id, user_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events?actor_email=eq.{MARKER.lower()}@example.com",
        headers=admin_headers(),
        timeout=30,
    )
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def valid_sig(ts, raw_body):
    return hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{ACTOR}.{raw_body}".encode(), hashlib.sha256
    ).hexdigest()


def forged_post(patient_id):
    """A well-formed partner update whose signature is INVALID (wrong secret)."""
    ts = str(int(time.time()))
    raw = json.dumps({
        "id": patient_id,
        "full_name": PATIENT_NAME,
        "current_management": ATTACKER_MGMT,
        "status": "discharged",
    })
    forged = hmac.new(
        b"not-the-real-secret", f"{ts}.{ACTOR}.{raw}".encode(), hashlib.sha256
    ).hexdigest()
    return requests.post(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={
            "Content-Type": "application/json",
            "x-timestamp": ts,
            "x-actor": ACTOR,
            "x-signature": forged,
        },
        data=raw,
        timeout=30,
    )


def forged_get():
    """A read attempt whose signature is INVALID."""
    ts = str(int(time.time()))
    return requests.get(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={
            "x-timestamp": ts,
            "x-actor": ACTOR,
            # signature computed over the wrong body/secret -> invalid
            "x-signature": "00" * 32,
        },
        timeout=30,
    )


def badge_locator(page):
    return page.get_by_text(re.compile(r"Last synced|Last sync failed")).first


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()
        before = read_patient(patient_id)

        # ---- A. REJECTION: forged-signature partner sync is refused ----
        resp = forged_post(patient_id)
        assert resp.status_code == 401, (
            f"forged POST should be 401, got {resp.status_code}: {resp.text[:300]}"
        )
        assert "Invalid signature" in resp.text, f"unexpected error body: {resp.text[:300]}"

        get_resp = forged_get()
        assert get_resp.status_code == 401, (
            f"forged GET should be 401, got {get_resp.status_code}: {get_resp.text[:300]}"
        )

        # No patient data may have changed as a result of the rejected sync.
        after = read_patient(patient_id)
        assert after == before, (
            f"patient row changed despite rejected sync!\nbefore={before}\nafter={after}"
        )
        assert after["current_management"] == SENTINEL_MGMT, "management field was overwritten"
        assert ATTACKER_MGMT not in json.dumps(after), "attacker payload leaked into the row"
        assert after["status"] == "admitted", "status changed despite rejected sync"

        # A rejected sync is recorded as an error event, as logSyncError() does.
        insert_sync_error(SYNC_ERR_MSG)

        # ---- B. UI ERROR: the sync badge reports the failure ----
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
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"

            badge = badge_locator(page)
            expect(badge).to_be_visible(timeout=15000)
            expect(page.get_by_text("Last sync failed").first).to_be_visible(timeout=15000)
            badge.hover()
            expect(page.get_by_text(re.compile(re.escape(SYNC_ERR_MSG))).first).to_be_visible(
                timeout=15000
            )
            page.screenshot(path=str(SCREENSHOTS / "badsig_sync_failed.png"))

            browser.close()

        # Final guard: still unchanged after the whole flow.
        final = read_patient(patient_id)
        assert final == before, "patient row changed by the end of the test"

        print(
            "PASS: forged-signature partner sync rejected (401), no patient data "
            "changed, and the UI reports the sync failure"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
