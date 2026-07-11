"""
End-to-end test: set the DNACPR decision AND the treatment escalation plan (TEP)
details for a patient, then confirm both render correctly on the patient page
AFTER the patient is discharged AND after a full page refresh.

Clinical records are retained after discharge (see src/lib/patients.functions.ts),
and the patient page's "Escalation & Resus" tab shows the TEP and DNACPR cards
(src/routes/_authenticated/patients.$patientId.tsx). This exercises the real
TanStack server-function RPC path the UI uses:

  1. RECORD    — set tep_in_place + tep_details AND dnacpr_decision + dnacpr_date
                 + dnacpr_details on an admitted patient.
  2. DISCHARGE — move the patient to "discharged"; both fields must survive.
  3. REFRESH   — hard-reload /patients/{id}, open Escalation & Resus, and confirm
                 "TEP in place", the TEP details, "DNACPR decision made", and the
                 DNACPR details all render for the discharged patient.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/dnacpr-tep-render-after-discharge-refresh.e2e.py
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

MARKER = f"E2E-DNACPR-TEP-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.T. Escalation"

TEP_DETAILS = f"For ward-based care, not for renal replacement therapy {MARKER}"
DNACPR_DETAILS = f"DNACPR agreed with family at MDT {MARKER}"
DNACPR_DATE = datetime.now(timezone.utc).date().isoformat()


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
            "current_management": f"Admitted {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,tep_in_place,tep_details,dnacpr_decision,dnacpr_details,dnacpr_date",
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
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- 1. RECORD DNACPR + TEP while admitted ----
            rec = call_fn(page, "updatePatient", {
                "id": patient_id,
                "tep_in_place": True,
                "tep_details": TEP_DETAILS,
                "dnacpr_decision": True,
                "dnacpr_date": DNACPR_DATE,
                "dnacpr_details": DNACPR_DETAILS,
            })
            assert rec["ok"], f"recording DNACPR/TEP should succeed: {rec.get('error')}"
            recorded = read_patient(patient_id)
            assert recorded["tep_in_place"] is True, "tep_in_place did not persist"
            assert recorded["tep_details"] == TEP_DETAILS, "tep_details did not persist"
            assert recorded["dnacpr_decision"] is True, "dnacpr_decision did not persist"
            assert recorded["dnacpr_details"] == DNACPR_DETAILS, "dnacpr_details did not persist"

            # ---- 2. DISCHARGE — both fields must survive the status change ----
            disch = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": f"Ward 10 {MARKER}",
            })
            assert disch["ok"], f"discharge should succeed: {disch.get('error')}"
            after = read_patient(patient_id)
            assert after["status"] == "discharged", f"status not discharged: {after['status']!r}"
            assert after["tep_in_place"] is True, "TEP flag lost through discharge"
            assert after["tep_details"] == TEP_DETAILS, "TEP details lost through discharge"
            assert after["dnacpr_decision"] is True, "DNACPR decision lost through discharge"
            assert after["dnacpr_details"] == DNACPR_DETAILS, "DNACPR details lost through discharge"

            # ---- 3. REFRESH — both render in the UI for the discharged patient ----
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

            # TEP card
            expect(esc_panel.get_by_text("TEP in place", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(esc_panel.get_by_text(TEP_DETAILS, exact=False).first).to_be_visible(
                timeout=10000
            )
            # DNACPR card
            expect(
                esc_panel.get_by_text("DNACPR decision made", exact=False).first
            ).to_be_visible(timeout=10000)
            expect(esc_panel.get_by_text(DNACPR_DETAILS, exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(path=str(SCREENSHOTS / "dnacpr_tep_after_discharge_refresh.png"))

            browser.close()

        print(
            "PASS: DNACPR decision and escalation plan render on the patient page "
            "after discharge and refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
