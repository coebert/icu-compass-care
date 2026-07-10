"""
End-to-end test: a patient record can be edited, discharged, and — once
discharged (a terminal status) — remains fully editable AND viewable with all
its saved data intact.

Records are retained after discharge/death (never hard-deleted) and, per the
lifecycle rules in src/lib/patients.functions.ts, a discharged patient stays
editable even though its status can no longer change. This test proves that
end-to-end through the app's genuine TanStack server-function RPC client (the
same path the UI uses) and confirms the discharged record still renders in the
app UI:

  1. EDIT (admitted)   — update the management note on an admitted patient;
                         confirm it persists (app read + independent DB read).
  2. DISCHARGE         — move the patient to "discharged" with a destination and
                         discharge date; confirm status + destination persist.
  3. EDITABLE (after)  — edit the management note AGAIN on the discharged record
                         and change the discharge destination; confirm both
                         persist and the discharged status is unchanged.
  4. VIEWABLE (UI)     — open /patients/{id} and confirm the record renders with
                         its saved name and the latest management note, and the
                         Status tab shows "Discharged" with the saved destination.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharge-record-editable.e2e.py
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

MARKER = f"E2E-DISCH-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.C.H."

INITIAL_MGMT = f"Admitted management note {MARKER}"
EDITED_MGMT = f"Edited while admitted {MARKER}"
POST_DISCHARGE_MGMT = f"Edited AFTER discharge {MARKER}"
DEST_1 = f"Ward 12 {MARKER}"
DEST_2 = f"Community rehab {MARKER}"


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
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
            "current_management": INITIAL_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_destination,current_management",
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

            # ---- 1. EDIT while admitted ----
            edit = call_fn(page, "updatePatient",
                           {"id": patient_id, "current_management": EDITED_MGMT})
            assert edit["ok"], f"edit while admitted should succeed: {edit.get('error')}"
            assert read_patient(patient_id)["current_management"] == EDITED_MGMT, (
                "admitted edit did not persist to the database"
            )

            # ---- 2. DISCHARGE (terminal status + required fields) ----
            discharge = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": DEST_1,
            })
            assert discharge["ok"], f"discharge should succeed: {discharge.get('error')}"
            after_discharge = read_patient(patient_id)
            assert after_discharge["status"] == "discharged", (
                f"status not persisted as discharged: {after_discharge['status']!r}"
            )
            assert after_discharge["discharge_destination"] == DEST_1, (
                "discharge destination did not persist"
            )

            # ---- 3. STILL EDITABLE once discharged ----
            reedit = call_fn(page, "updatePatient", {
                "id": patient_id,
                "current_management": POST_DISCHARGE_MGMT,
                "discharge_destination": DEST_2,
            })
            assert reedit["ok"], (
                f"editing a DISCHARGED record should succeed: {reedit.get('error')}"
            )
            final = read_patient(patient_id)
            assert final["current_management"] == POST_DISCHARGE_MGMT, (
                "post-discharge management edit did not persist"
            )
            assert final["discharge_destination"] == DEST_2, (
                "post-discharge destination edit did not persist"
            )
            assert final["status"] == "discharged", (
                f"status must remain discharged after edit, got {final['status']!r}"
            )
            # The app's own read agrees.
            app_read = call_fn(page, "getPatient", {"id": patient_id})
            assert app_read["ok"], f"getPatient on discharged record failed: {app_read.get('error')}"
            assert app_read["result"]["current_management"] == POST_DISCHARGE_MGMT
            assert app_read["result"]["status"] == "discharged"

            # ---- 4. VIEWABLE in the UI ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_text(POST_DISCHARGE_MGMT, exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(path=str(SCREENSHOTS / "discharge_editable_overview.png"))

            # Status tab shows Discharged + the saved destination.
            status_tab = page.get_by_role("tab", name="Status")
            status_tab.scroll_into_view_if_needed()
            status_tab.click()
            expect(status_tab).to_have_attribute("data-state", "active", timeout=10000)
            status_panel = page.get_by_role("tabpanel")
            expect(status_panel.get_by_text("Discharged", exact=False).first).to_be_visible(
                timeout=10000
            )
            # The discharge destination renders in an editable input field.
            expect(
                status_panel.locator(f"input[value='{DEST_2}']")
            ).to_have_count(1, timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "discharge_editable_status.png"))

            browser.close()

        print("PASS: patient edited, discharged, and the discharged record stays editable + viewable")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
