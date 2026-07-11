"""
End-to-end test: record a patient on an OUTLYING ward (location_type=outlier,
status=referred), progress the status through Admitted and then Discharged (with
a discharge destination), and confirm every change persists and displays after a
full page reload.

Status transitions are enforced by src/lib/patient-schema.ts
(referred -> admitted -> discharged; discharged requires a destination + date).
This exercises the app's genuine TanStack server-function RPC path
(updatePatient in src/lib/patients.functions.ts) — the same one the Status tab
uses — then verifies the stored data (DB read) and what the UI renders.

  1. RECORD (outlier)  — patient created on an outlying ward as "referred".
  2. ADMIT             — referred -> admitted; confirm it persists.
  3. DISCHARGE         — admitted -> discharged with destination + date;
                         confirm it persists.
  4. RELOAD (UI)       — hard-reload /patients/{id} and confirm the Status tab
                         shows "Discharged", the ward name renders, and the
                         discharge destination is shown.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/outlier-status-progression-persists.e2e.py
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

MARKER = f"E2E-OUTLIER-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.W. Progression"
WARD = f"Ward 22 (Surgery) {MARKER}"
DESTINATION = f"Repatriated to base hospital {MARKER}"


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
            "age": 63,
            "location_type": "outlier",
            "ward": WARD,
            "bed": "4",
            "status": "referred",
            "current_management": f"Outlier review requested {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,location_type,ward,discharge_destination,discharge_date",
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

            # ---- 0. Confirm the outlier starting point persisted ----
            start = read_patient(patient_id)
            assert start["status"] == "referred", f"start status: {start['status']!r}"
            assert start["location_type"] == "outlier", (
                f"expected outlier ward, got {start['location_type']!r}"
            )
            assert start["ward"] == WARD, f"ward not stored: {start['ward']!r}"

            # ---- 1. referred -> admitted ----
            adm = call_fn(page, "updatePatient", {"id": patient_id, "status": "admitted"})
            assert adm["ok"], f"admit should succeed: {adm.get('error')}"
            after_adm = read_patient(patient_id)
            assert after_adm["status"] == "admitted", (
                f"status not admitted: {after_adm['status']!r}"
            )
            assert after_adm["ward"] == WARD, "ward lost through admission"

            # ---- 2. admitted -> discharged (destination + date required) ----
            disch = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": DESTINATION,
            })
            assert disch["ok"], f"discharge should succeed: {disch.get('error')}"
            after_disch = read_patient(patient_id)
            assert after_disch["status"] == "discharged", (
                f"status not discharged: {after_disch['status']!r}"
            )
            assert after_disch["discharge_destination"] == DESTINATION, (
                f"destination not stored: {after_disch['discharge_destination']!r}"
            )
            assert after_disch["discharge_date"] == today, "discharge date not stored"

            # ---- 3. RELOAD — data displays correctly in the UI ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            # Ward renders on the page header.
            expect(page.get_by_text(WARD, exact=False).first).to_be_visible(timeout=10000)
            # Discharge destination renders (timeline / overview).
            expect(page.get_by_text(DESTINATION, exact=False).first).to_be_visible(
                timeout=10000
            )

            # Status tab reflects "Discharged" and shows the saved destination input.
            status_tab = page.get_by_role("tab", name="Status")
            status_tab.scroll_into_view_if_needed()
            status_tab.click()
            expect(status_tab).to_have_attribute("data-state", "active", timeout=10000)
            status_panel = page.get_by_role("tabpanel")
            expect(status_panel.get_by_text("Discharged", exact=False).first).to_be_visible(
                timeout=10000
            )
            dest_input = status_panel.get_by_role("textbox").last
            expect(dest_input).to_have_value(DESTINATION, timeout=10000)
            page.screenshot(
                path=str(SCREENSHOTS / "outlier_status_progression_after_reload.png")
            )

            browser.close()

        print(
            "PASS: outlier patient progressed referred -> admitted -> discharged; "
            "ward + discharge destination persist and display after reload"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
