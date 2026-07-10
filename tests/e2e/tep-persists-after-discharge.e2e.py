"""
End-to-end test: a treatment escalation plan (TEP) can be recorded on a patient
and — because clinical records are retained after discharge and a discharged
patient stays editable (see src/lib/patients.functions.ts) — the TEP persists
through discharge AND remains editable afterwards.

This runs through the app's genuine TanStack server-function RPC client (the
same path the UI uses) and confirms the TEP renders in the app's
"Escalation & Resus" tab:

  1. RECORD TEP        — set tep_in_place=true with details on an admitted
                         patient; confirm it persists (app read + DB read).
  2. DISCHARGE         — move the patient to "discharged"; confirm the TEP
                         (flag + details) survives the status change unchanged.
  3. EDITABLE (after)  — edit the TEP details on the discharged record; confirm
                         the edit persists and the status stays "discharged".
  4. VIEWABLE (UI)     — open /patients/{id}, Escalation & Resus tab, and confirm
                         "TEP in place" plus the latest details render.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/tep-persists-after-discharge.e2e.py
Exits 0 on success, non-zero on failure.
"""

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

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-TEP-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.E.P."

TEP_DETAILS_1 = f"For ward-based care, not for renal replacement therapy {MARKER}"
TEP_DETAILS_2 = f"Ceiling of care updated after MDT discussion {MARKER}"


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
            "age": 74,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
            "current_management": f"Admitted {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,tep_in_place,tep_details",
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
            # Land on a stable authenticated page before running any evaluate.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- 1. RECORD the TEP while admitted ----
            rec = call_fn(page, "updatePatient", {
                "id": patient_id,
                "tep_in_place": True,
                "tep_details": TEP_DETAILS_1,
            })
            assert rec["ok"], f"recording TEP should succeed: {rec.get('error')}"
            recorded = read_patient(patient_id)
            assert recorded["tep_in_place"] is True, "tep_in_place did not persist as true"
            assert recorded["tep_details"] == TEP_DETAILS_1, "tep_details did not persist"

            # ---- 2. DISCHARGE — the TEP must survive the status change ----
            disch = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": f"Ward 10 {MARKER}",
            })
            assert disch["ok"], f"discharge should succeed: {disch.get('error')}"
            after = read_patient(patient_id)
            assert after["status"] == "discharged", (
                f"status not persisted as discharged: {after['status']!r}"
            )
            assert after["tep_in_place"] is True, "TEP flag lost through discharge"
            assert after["tep_details"] == TEP_DETAILS_1, "TEP details lost through discharge"

            # ---- 3. STILL EDITABLE once discharged ----
            reedit = call_fn(page, "updatePatient", {
                "id": patient_id,
                "tep_details": TEP_DETAILS_2,
            })
            assert reedit["ok"], (
                f"editing the TEP on a DISCHARGED record should succeed: {reedit.get('error')}"
            )
            final = read_patient(patient_id)
            assert final["tep_details"] == TEP_DETAILS_2, (
                "post-discharge TEP edit did not persist"
            )
            assert final["tep_in_place"] is True, "TEP flag must remain in place after edit"
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit, got {final['status']!r}"
            )
            # The app's own read agrees.
            app_read = call_fn(page, "getPatient", {"id": patient_id})
            assert app_read["ok"], f"getPatient failed: {app_read.get('error')}"
            assert app_read["result"]["tep_in_place"] is True
            assert app_read["result"]["tep_details"] == TEP_DETAILS_2
            assert app_read["result"]["status"] == "discharged"

            # ---- 4. VIEWABLE in the UI (Escalation & Resus tab) ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            esc_tab = page.get_by_role("tab", name="Escalation & Resus")
            esc_tab.scroll_into_view_if_needed()
            esc_tab.click()
            expect(esc_tab).to_have_attribute("data-state", "active", timeout=10000)
            esc_panel = page.get_by_role("tabpanel")
            expect(esc_panel.get_by_text("TEP in place", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(esc_panel.get_by_text(TEP_DETAILS_2, exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(path=str(SCREENSHOTS / "tep_after_discharge.png"))

            browser.close()

        print("PASS: TEP recorded, survived discharge, stayed editable, and renders in the UI")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
