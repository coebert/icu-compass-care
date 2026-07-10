"""
End-to-end test: a DNACPR decision (with a decision date and clinical details)
recorded on a patient persists across the cross-project bridge sync AND remains
editable — the edit propagating over the bridge too.

Records go through the app's genuine TanStack server-function RPC client
(updatePatient / getPatient in src/lib/patients.functions.ts) — the same path
the UI uses — and the partner view is fetched through the real HMAC-signed
bridge endpoint (GET /api/public/bridge/patients) exactly as the partner app
would call it.

Steps:
  1. RECORD    — set dnacpr_decision=true with dnacpr_date + dnacpr_details on an
                 admitted patient; confirm persistence (app read + DB read).
  2. SYNC #1   — pull the patient over the signed bridge; the partner sees the
                 DNACPR decision, date and details.
  3. EDIT      — change dnacpr_details (and the decision date) on the same
                 record; confirm the decision flag stays true and the edit
                 persists (app read + DB read).
  4. SYNC #2   — pull over the bridge again; the partner now sees the EDITED
                 details/date, no longer the original, decision still true.
  5. VIEW (UI) — open /patients/{id}, go to Escalation & Resus, and confirm the
                 "DNACPR decision made" badge, British-formatted date, and the
                 edited details all render.

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/dnacpr-persists-after-sync-editable.e2e.py
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

MARKER = f"E2E-DNRSYNC2-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.N.E."

DNACPR_DATE = "2024-05-06"           # stored ISO; UI shows 06/05/2024
DNACPR_DATE_UK = "06/05/2024"
DNACPR_DETAILS = f"DNACPR agreed with patient and family {MARKER}"

DNACPR_DATE_2 = "2024-06-11"         # edited date; UI shows 11/06/2024
DNACPR_DATE_2_UK = "11/06/2024"
DNACPR_DETAILS_2 = f"DNACPR reviewed and re-confirmed at MDT {MARKER}"


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
            "age": 77,
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
        "&select=status,dnacpr_decision,dnacpr_date,dnacpr_details",
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

            # ---- 1. RECORD the DNACPR decision ----
            rec = call_fn(page, "updatePatient", {
                "id": patient_id,
                "dnacpr_decision": True,
                "dnacpr_date": DNACPR_DATE,
                "dnacpr_details": DNACPR_DETAILS,
            })
            assert rec["ok"], f"recording DNACPR failed: {rec.get('error')}"
            row = read_patient(patient_id)
            assert row["dnacpr_decision"] is True, "dnacpr_decision not stored"
            assert row["dnacpr_date"] == DNACPR_DATE, f"date not stored: {row['dnacpr_date']!r}"
            assert row["dnacpr_details"] == DNACPR_DETAILS, "details not stored"

            # ---- 2. SYNC #1 ----
            synced = bridge_get_patient(patient_id)
            assert synced is not None, "patient not returned over the bridge"
            assert synced["dnacpr_decision"] is True, "bridge missing DNACPR decision"
            assert synced["dnacpr_date"] == DNACPR_DATE, "bridge missing DNACPR date"
            assert synced["dnacpr_details"] == DNACPR_DETAILS, "bridge missing DNACPR details"

            # ---- 3. EDIT the decision details + date ----
            ed = call_fn(page, "updatePatient", {
                "id": patient_id,
                "dnacpr_date": DNACPR_DATE_2,
                "dnacpr_details": DNACPR_DETAILS_2,
            })
            assert ed["ok"], f"editing DNACPR failed: {ed.get('error')}"
            after = read_patient(patient_id)
            assert after["dnacpr_decision"] is True, "DNACPR flag lost on edit"
            assert after["dnacpr_date"] == DNACPR_DATE_2, "edited date did not persist"
            assert after["dnacpr_details"] == DNACPR_DETAILS_2, "edited details did not persist"

            # ---- 4. SYNC #2 (after edit) ----
            synced2 = bridge_get_patient(patient_id)
            assert synced2 is not None, "patient not returned over the bridge after edit"
            assert synced2["dnacpr_decision"] is True, "bridge lost DNACPR decision after edit"
            assert synced2["dnacpr_date"] == DNACPR_DATE_2, "bridge missing edited date"
            assert synced2["dnacpr_details"] == DNACPR_DETAILS_2, "bridge missing edited details"
            assert synced2["dnacpr_details"] != DNACPR_DETAILS, (
                "bridge still showing the pre-edit details"
            )

            # ---- 5. VIEW in the UI ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            tab = page.get_by_role("tab", name="Escalation & Resus")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            panel = page.get_by_role("tabpanel")
            expect(panel.get_by_text("DNACPR decision made")).to_be_visible(timeout=10000)
            expect(panel.get_by_text(DNACPR_DATE_2_UK, exact=False)).to_be_visible(timeout=10000)
            expect(panel.get_by_text(DNACPR_DETAILS_2, exact=False)).to_be_visible(timeout=10000)
            assert panel.get_by_text(DNACPR_DETAILS, exact=False).count() == 0, (
                "old DNACPR details should no longer be shown"
            )
            page.screenshot(path=str(SCREENSHOTS / "dnacpr_sync_editable.png"))

            browser.close()

        print(
            "PASS: DNACPR decision + details persist across bridge sync and remain "
            "editable (edit propagates over the bridge)"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
