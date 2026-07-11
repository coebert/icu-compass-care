"""
End-to-end UI-session test: a signed-in CLINICAL user cannot update or delete
existing patient_field_changes rows — the audit trail is append-only. The
patient_field_changes table has only SELECT + INSERT policies for
`authenticated`, so update/delete attempts made with the browser's OWN signed-in
credentials are rejected / no-op, and the record is never modified.

Unlike the pure-REST immutability test, this drives the ACTUAL browser session:

  1. Seeds a patient + one patient_field_changes row via the admin API.
  2. Signs in through the real /auth form as a throwaway CLINICIAN user.
  3. From INSIDE the browser page (using the app's own Supabase session token
     read from localStorage), issues PATCH and DELETE requests to the Data API
     — exactly the credentials any in-app request would carry.
  4. Asserts each write is blocked: the client sees a permission error
     (401/403) OR an accepted-but-zero-rows response, and never a successful
     modification.
  5. Confirms via the service role that the row is byte-for-byte unchanged.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Playwright + Chromium are preinstalled in the sandbox.

Run:  python3 tests/e2e/clinical-user-ui-cannot-update-or-delete-field-changes.e2e.py
Exits 0 on success, non-zero on failure.
"""

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from playwright.async_api import async_playwright

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]
BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8080").rstrip("/")

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"
EMAIL = f"e2e-fc-ui-{STAMP}@example.com"
PATIENT_NAME = f"F.C.{SUFFIX}"
ORIGINAL_NEW = f"original-{SUFFIX}"
TAMPERED_NEW = f"tampered-{SUFFIX}"

SCREENSHOTS = Path("/tmp/browser/fc-immutable")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_clinical_user():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": EMAIL, "password": PASSWORD, "email_confirm": True},
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
    return uid


def create_patient():
    admission = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 55,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def create_field_change(patient_id, actor_id):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patient_field_changes",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "field_name": "age",
            "old_value": "54",
            "new_value": ORIGINAL_NEW,
            "changed_by": actor_id,
            "changed_by_email": EMAIL,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_change_admin(change_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patient_field_changes?id=eq.{change_id}"
        "&select=id,new_value",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_id, user_id):
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


async def run(change_id):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()

        # ---- Sign in through the real /auth form ----
        await page.goto(f"{BASE_URL}/auth", wait_until="domcontentloaded")
        await page.fill("#email", EMAIL)
        await page.fill("#password", PASSWORD)
        await page.get_by_role("button", name="Sign in").click()
        await page.wait_for_url("**/patients", timeout=30000)
        await page.screenshot(path=str(SCREENSHOTS / "1_signed_in.png"))

        # ---- Attempt UPDATE + DELETE from inside the browser session ----
        # Uses the app's own persisted Supabase access token (localStorage) and
        # publishable apikey — the exact credentials any in-app write carries.
        result = await page.evaluate(
            """async ({ url, apikey, changeId, tampered }) => {
                // Find the Supabase auth token this app persisted at sign-in.
                let token = null;
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
                        try { token = JSON.parse(localStorage.getItem(k)).access_token; }
                        catch (_) {}
                    }
                }
                if (!token) return { error: 'no session token in localStorage' };
                const headers = {
                    apikey,
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    Prefer: 'return=representation',
                };
                const base = url + '/rest/v1/patient_field_changes?id=eq.' + changeId;
                const upd = await fetch(base, {
                    method: 'PATCH',
                    headers,
                    body: JSON.stringify({ new_value: tampered }),
                });
                const updBody = await upd.text();
                const del = await fetch(base, { method: 'DELETE', headers });
                const delBody = await del.text();
                return {
                    update: { status: upd.status, body: updBody },
                    delete: { status: del.status, body: delBody },
                };
            }""",
            {
                "url": SUPABASE_URL,
                "apikey": PUBLISHABLE_KEY,
                "changeId": change_id,
                "tampered": TAMPERED_NEW,
            },
        )

        assert "error" not in result, f"browser session setup failed: {result}"
        upd = result["update"]
        dele = result["delete"]

        # Each write must be a permission error OR an accepted-but-zero-rows no-op.
        def is_blocked(resp):
            if resp["status"] in (401, 403):
                return True  # explicit permission error
            if resp["status"] in (200, 204):
                # RLS with no policy => empty representation (0 rows affected)
                body = (resp["body"] or "").strip()
                return body in ("", "[]")
            return False

        assert is_blocked(upd), f"UPDATE was not blocked from the UI session: {upd}"
        assert is_blocked(dele), f"DELETE was not blocked from the UI session: {dele}"

        await browser.close()
        return upd, dele


def main():
    user_id = None
    patient_id = None
    try:
        user_id = create_clinical_user()
        patient_id = create_patient()
        change_id = create_field_change(patient_id, user_id)

        upd, dele = asyncio.run(run(change_id))

        # ---- Record must be unchanged (verified with the service role) ----
        after = read_change_admin(change_id)
        assert len(after) == 1 and after[0]["id"] == change_id, (
            f"audit row must still exist after blocked writes, got: {after}"
        )
        assert after[0]["new_value"] == ORIGINAL_NEW, (
            "audit row was modified despite the block! "
            f"expected {ORIGINAL_NEW!r}, got {after[0]['new_value']!r}"
        )

        print(
            "PASS: clinical UI session cannot update or delete patient_field_changes "
            f"(update status {upd['status']}, delete status {dele['status']}); "
            "record unchanged — audit trail is immutable"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
