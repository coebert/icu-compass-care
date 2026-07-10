"""
End-to-end test: a Treatment Escalation Plan (TEP) with escalation details
recorded on an admitted patient persists after the patient is discharged, stays
visible to the partner app through the cross-project bridge sync, and can be
edited again afterwards (the edit persisting through the same paths).

Records go through the app's genuine TanStack server-function RPC client
(updatePatient / getPatient in src/lib/patients.functions.ts) — the same path
the UI uses — and the partner view is fetched through the real HMAC-signed
bridge endpoint (GET /api/public/bridge/patients) exactly as the partner app
would call it.

Steps:
  1. RECORD    — set tep_in_place=true with tep_details on an admitted patient;
                 confirm persistence (app read + DB read).
  2. SYNC #1   — pull the patient over the signed bridge and confirm the partner
                 sees the TEP flag + details while still admitted.
  3. DISCHARGE — move the patient to "discharged" (with destination + date);
                 confirm the TEP fields survive the status change.
  4. SYNC #2   — pull over the bridge again and confirm the partner sees
                 status=discharged AND the TEP flag/details intact.
  5. EDIT      — change the escalation details on the discharged record; confirm
                 the edit persists (DB read), stays visible over the bridge, and
                 renders on the Escalation & Resus tab, while status stays
                 discharged.

Throwaway clinician user + patient are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/tep-persists-after-discharge-sync-editable.e2e.py
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

MARKER = f"E2E-TEPSYNC-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.E.P.Sync"

TEP_1 = f"Ward-based care, no further ICU escalation {MARKER}"
TEP_2 = f"Ceiling of care revised after MDT — for ward NIV only {MARKER}"
DEST = f"Ward 6 {MARKER}"


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
            "age": 79,
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
        "&select=status,tep_in_place,tep_details,discharge_destination",
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


def open_escalation_tab(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
    tab = page.get_by_role("tab", name="Escalation & Resus")
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
        today = datetime.now(timezone.utc).date().isoformat()

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

            # ---- 1. RECORD the TEP + escalation details ----
            rec = call_fn(page, "updatePatient", {
                "id": patient_id,
                "tep_in_place": True,
                "tep_details": TEP_1,
            })
            assert rec["ok"], f"recording TEP failed: {rec.get('error')}"
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place not stored"
            assert row["tep_details"] == TEP_1, f"tep_details not stored: {row['tep_details']!r}"

            # ---- 2. SYNC #1 (still admitted) ----
            synced = bridge_get_patient(patient_id)
            assert synced is not None, "patient not returned over the bridge"
            assert synced["tep_in_place"] is True, "bridge missing TEP flag"
            assert synced["tep_details"] == TEP_1, "bridge missing TEP details"

            # ---- 3. DISCHARGE ----
            disc = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": DEST,
            })
            assert disc["ok"], f"discharge failed: {disc.get('error')}"
            after = read_patient(patient_id)
            assert after["status"] == "discharged", f"not discharged: {after['status']!r}"
            assert after["tep_in_place"] is True, "TEP flag lost on discharge"
            assert after["tep_details"] == TEP_1, "TEP details lost on discharge"

            # ---- 4. SYNC #2 (discharged) ----
            synced2 = bridge_get_patient(patient_id)
            assert synced2 is not None, "discharged patient not returned over the bridge"
            assert synced2["status"] == "discharged", (
                f"bridge status not discharged: {synced2['status']!r}"
            )
            assert synced2["tep_in_place"] is True, "bridge lost TEP flag post-discharge"
            assert synced2["tep_details"] == TEP_1, "bridge lost TEP details post-discharge"

            # View the discharged record with TEP intact.
            panel = open_escalation_tab(page)
            expect(panel.get_by_text("TEP in place")).to_be_visible(timeout=10000)
            expect(panel.get_by_text(TEP_1, exact=False)).to_be_visible(timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "tepsync_after_discharge.png"))

            # ---- 5. EDIT the escalation details on the discharged record ----
            edit = call_fn(page, "updatePatient", {
                "id": patient_id,
                "tep_details": TEP_2,
            })
            assert edit["ok"], f"editing TEP after discharge failed: {edit.get('error')}"
            final = read_patient(patient_id)
            assert final["tep_details"] == TEP_2, (
                f"post-discharge TEP edit did not persist: {final['tep_details']!r}"
            )
            assert final["tep_in_place"] is True, "TEP flag lost after edit"
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit: {final['status']!r}"
            )

            # Edit visible over the bridge too.
            synced3 = bridge_get_patient(patient_id)
            assert synced3 is not None, "edited patient not returned over the bridge"
            assert synced3["tep_details"] == TEP_2, "bridge did not reflect edited TEP details"

            # Edit renders in the UI.
            panel = open_escalation_tab(page)
            expect(panel.get_by_text(TEP_2, exact=False)).to_be_visible(timeout=10000)
            assert panel.get_by_text(TEP_1, exact=False).count() == 0, (
                "old TEP details should no longer be shown"
            )
            page.screenshot(path=str(SCREENSHOTS / "tepsync_edited_after_discharge.png"))

            browser.close()

        print(
            "PASS: TEP + escalation details persist after discharge and bridge "
            "sync, and remain editable"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
