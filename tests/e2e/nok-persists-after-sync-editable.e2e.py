"""
End-to-end test: updating a patient's next-of-kin (NOK) details together with
the "last updated" timestamp persists, stays visible to the partner app through
the cross-project bridge sync, and can be edited again afterwards.

Records go through the app's genuine TanStack server-function RPC client
(updatePatient / getPatient in src/lib/patients.functions.ts) — the same path
the UI uses — and the partner view is fetched through the real HMAC-signed
bridge endpoint (GET /api/public/bridge/patients) exactly as the partner app
would call it.

Steps:
  1. RECORD    — set nok_name / nok_relationship / nok_contact plus
                 nok_last_updated (timestamp) and nok_last_updated_by on an
                 admitted patient; confirm persistence (app read + DB read).
  2. SYNC #1   — pull the patient over the signed bridge and confirm the partner
                 sees all NOK fields and the last-updated timestamp.
  3. EDIT      — change the NOK contact and bump the last-updated timestamp;
                 confirm the edit persists (DB read).
  4. SYNC #2   — pull over the bridge again and confirm the partner sees the
                 edited contact and the new timestamp.
  5. VIEW (UI) — open /patients/{id}, go to the Next of kin tab, and confirm the
                 updated name, relationship, edited contact and "updated by" all
                 render on the record.

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/nok-persists-after-sync-editable.e2e.py
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-NOKSYNC-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.O.K.Sync"

NOK_NAME = f"Jane Doe {MARKER}"
NOK_REL = "Daughter"
NOK_CONTACT_1 = f"07700 900111 {MARKER}"
NOK_CONTACT_2 = f"07700 900999 {MARKER}"
NOK_BY = f"Nurse Practitioner {MARKER}"
# Distinct ISO timestamps; the second is strictly later than the first.
NOK_TS_1 = "2024-05-06T09:15:00.000Z"
NOK_TS_2 = "2024-05-07T16:40:00.000Z"


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
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
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
        "&select=nok_name,nok_relationship,nok_contact,nok_last_updated,nok_last_updated_by",
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


def bridge_get_patient(patient_id):
    """Fetch patients as the partner app would: HMAC-signed GET, then filter."""
    actor = json.dumps(
        {"id": "00000000-0000-0000-0000-000000000000", "email": "partner@care.test", "role": "clinician"}
    )
    ts = str(int(time.time()))
    sig = hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{actor}.".encode(), hashlib.sha256
    ).hexdigest()
    r = requests.get(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={"x-timestamp": ts, "x-actor": actor, "x-signature": sig},
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()["patients"]
    return next((p for p in rows if p["id"] == patient_id), None)


CALL_SERVER_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn({ data: arg.data });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def call_fn(page, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": FUNCTIONS_MODULE, "name": name, "data": data}
    )


def ts_equal(a, b):
    """Compare two ISO timestamps by instant (tolerate +00:00 vs Z, offsets)."""
    if a is None or b is None:
        return a == b
    return datetime.fromisoformat(a.replace("Z", "+00:00")) == datetime.fromisoformat(
        b.replace("Z", "+00:00")
    )


def open_nok_tab(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
    tab = page.get_by_role("tab", name="Next of kin")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


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
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            # ---- 1. RECORD the NOK details + last-updated timestamp ----
            rec = call_fn(page, "updatePatient", {
                "id": patient_id,
                "nok_name": NOK_NAME,
                "nok_relationship": NOK_REL,
                "nok_contact": NOK_CONTACT_1,
                "nok_last_updated": NOK_TS_1,
                "nok_last_updated_by": NOK_BY,
            })
            assert rec["ok"], f"recording NOK failed: {rec.get('error')}"
            row = read_patient(patient_id)
            assert row["nok_name"] == NOK_NAME, f"name not stored: {row['nok_name']!r}"
            assert row["nok_relationship"] == NOK_REL, "relationship not stored"
            assert row["nok_contact"] == NOK_CONTACT_1, "contact not stored"
            assert row["nok_last_updated_by"] == NOK_BY, "updated-by not stored"
            assert ts_equal(row["nok_last_updated"], NOK_TS_1), (
                f"last-updated not stored: {row['nok_last_updated']!r}"
            )

            # ---- 2. SYNC #1 ----
            synced = bridge_get_patient(patient_id)
            assert synced is not None, "patient not returned over the bridge"
            assert synced["nok_name"] == NOK_NAME, "bridge missing NOK name"
            assert synced["nok_relationship"] == NOK_REL, "bridge missing NOK relationship"
            assert synced["nok_contact"] == NOK_CONTACT_1, "bridge missing NOK contact"
            assert synced["nok_last_updated_by"] == NOK_BY, "bridge missing NOK updated-by"
            assert ts_equal(synced["nok_last_updated"], NOK_TS_1), "bridge missing NOK timestamp"

            # ---- 3. EDIT the contact and bump the last-updated timestamp ----
            edit = call_fn(page, "updatePatient", {
                "id": patient_id,
                "nok_contact": NOK_CONTACT_2,
                "nok_last_updated": NOK_TS_2,
            })
            assert edit["ok"], f"editing NOK failed: {edit.get('error')}"
            after = read_patient(patient_id)
            assert after["nok_contact"] == NOK_CONTACT_2, (
                f"edited contact did not persist: {after['nok_contact']!r}"
            )
            assert ts_equal(after["nok_last_updated"], NOK_TS_2), (
                f"edited timestamp did not persist: {after['nok_last_updated']!r}"
            )
            # Untouched fields must remain intact.
            assert after["nok_name"] == NOK_NAME, "name lost after edit"
            assert after["nok_relationship"] == NOK_REL, "relationship lost after edit"

            # ---- 4. SYNC #2 ----
            synced2 = bridge_get_patient(patient_id)
            assert synced2 is not None, "edited patient not returned over the bridge"
            assert synced2["nok_contact"] == NOK_CONTACT_2, "bridge did not reflect edited contact"
            assert ts_equal(synced2["nok_last_updated"], NOK_TS_2), (
                "bridge did not reflect edited timestamp"
            )

            # ---- 5. VIEW in the UI ----
            panel = open_nok_tab(page)
            expect(panel.get_by_text(NOK_NAME, exact=False)).to_be_visible(timeout=10000)
            expect(panel.get_by_text(NOK_REL, exact=False)).to_be_visible(timeout=10000)
            expect(panel.get_by_text(NOK_CONTACT_2, exact=False)).to_be_visible(timeout=10000)
            expect(panel.get_by_text(NOK_BY, exact=False)).to_be_visible(timeout=10000)
            assert panel.get_by_text(NOK_CONTACT_1, exact=False).count() == 0, (
                "old NOK contact should no longer be shown"
            )
            page.screenshot(path=str(SCREENSHOTS / "noksync_edited.png"))

            browser.close()

        print(
            "PASS: NOK details + last-updated timestamp persist through partner "
            "sync and remain editable"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
