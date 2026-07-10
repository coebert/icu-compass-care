"""
End-to-end test: a patient's clinical lifecycle transition to "died" is recorded
correctly, and the completed (discharge-like) record remains VISIBLE and
EDITABLE afterwards — matching the project rule that records are retained after
discharge/death and never hard-deleted, and that all signed-in staff keep
full read/write access.

Driven through the app's real TanStack server-function RPC layer with an
authenticated clinician session (same approach as auth-access-control.e2e.py).

What it asserts:
  1. Start state — patient is created "admitted" and is visible in the board list.
  2. Transition — updatePatient moves status admitted -> died (with a
     discharge_date), and the change succeeds.
  3. Audit trail — the transition is captured in the patient audit history.
  4. Post-completion VISIBILITY — the died patient is still returned by
     getPatient AND still appears in listPatients (not filtered out).
  5. Post-completion EDITABILITY — a further edit (e.g. amending management /
     discharge_destination) on the died record still succeeds and persists.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-lifecycle-death.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

MARKER = f"E2E-LIFECYCLE-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
INITIAL_MGMT = f"Active management {MARKER}"
POSTDEATH_MGMT = f"Amended after death {MARKER}"
DISCHARGE_DEST = "Mortuary"
PATIENT_NAME = "L.D."


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
            "current_management": INITIAL_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,current_management,discharge_destination,discharge_date",
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

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            # Reload so the app's Supabase client picks up the restored session
            # and the client bearer middleware can attach the token to RPC calls.
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # ---- 1. Start state: admitted + visible in the list ----
            start = call_fn(page, "getPatient", {"id": patient_id})
            assert start["ok"], f"getPatient failed: {start.get('error')}"
            assert start["result"]["status"] == "admitted", "patient did not start as admitted"

            listed = call_fn(page, "listPatients", {})
            assert listed["ok"], f"listPatients failed: {listed.get('error')}"
            assert any(p["id"] == patient_id for p in listed["result"]), (
                "admitted patient missing from board list"
            )

            # ---- 2. Transition admitted -> died ----
            died = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "died",
                "discharge_date": time.strftime("%Y-%m-%d"),
                "discharge_destination": DISCHARGE_DEST,
            })
            assert died["ok"], f"transition to died failed: {died.get('error')}"
            assert died["result"]["status"] == "died", "status not persisted as died"
            assert read_patient(patient_id)["status"] == "died", (
                "died status not persisted to the database"
            )

            # ---- 3. Audit trail captured the transition ----
            # record_audit SELECT is admin-only under RLS, so a clinician's
            # getPatientAudit legitimately returns nothing; verify the audit
            # entry via an independent admin read instead.
            audit_actions = read_audit_actions(patient_id)
            assert "update" in audit_actions, (
                f"no update entry recorded for the death transition: {audit_actions}"
            )


            # ---- 4. Post-completion VISIBILITY: still readable + still listed ----
            after = call_fn(page, "getPatient", {"id": patient_id})
            assert after["ok"] and after["result"], "died patient no longer readable"
            assert after["result"]["status"] == "died"

            listed_after = call_fn(page, "listPatients", {})
            assert listed_after["ok"], f"listPatients failed post-death: {listed_after.get('error')}"
            assert any(p["id"] == patient_id for p in listed_after["result"]), (
                "died patient was filtered out of the board list — completed records must remain visible"
            )

            # ---- 5. Post-completion EDITABILITY: further edits still succeed ----
            amend = call_fn(page, "updatePatient", {
                "id": patient_id,
                "current_management": POSTDEATH_MGMT,
            })
            assert amend["ok"], f"editing a died record was blocked: {amend.get('error')}"

            reread = read_patient(patient_id)
            assert reread["current_management"] == POSTDEATH_MGMT, (
                "post-death amendment did not persist — completed records must stay editable"
            )
            assert reread["status"] == "died", "amendment unexpectedly changed the status"
            assert reread["discharge_destination"] == DISCHARGE_DEST, (
                "discharge destination lost after amendment"
            )

            browser.close()

        print("PASS: admitted->died transition recorded; record stays visible and editable after completion")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
