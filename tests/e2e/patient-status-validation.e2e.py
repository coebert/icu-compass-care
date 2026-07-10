"""
End-to-end test: server-side patient status-transition and per-status
required-field validation.

Drives the real TanStack server-function RPC layer as an authenticated
clinician and asserts the server (not just the UI) enforces:

  1. Required fields per status:
     - marking "discharged" without a discharge destination is rejected
     - marking "discharged" without a discharge date is rejected
     - marking "died" without a date of death is rejected
  2. Legal transitions succeed (admitted -> discharged with the required fields).
  3. Illegal transitions are rejected (terminal "discharged" -> "admitted").
  4. Same-status edits (no lifecycle change) are always allowed.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-status-validation.e2e.py
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

MARKER = f"E2E-STATUS-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
TODAY = time.strftime("%Y-%m-%d")


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
            "full_name": "S.V.",
            "age": 62,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_status(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=status",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["status"]


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


def assert_rejected(outcome, needle, label):
    assert not outcome["ok"], f"{label} should have been rejected but succeeded"
    assert needle.lower() in outcome["error"].lower(), (
        f"{label} rejected, but message did not mention {needle!r}: {outcome['error']}"
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
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # ---- 1a. discharged without a destination is rejected ----
            assert_rejected(
                call_fn(page, "updatePatient",
                        {"id": patient_id, "status": "discharged", "discharge_date": TODAY}),
                "discharge destination",
                "Discharge without a destination",
            )
            # ---- 1b. discharged without a date is rejected ----
            assert_rejected(
                call_fn(page, "updatePatient",
                        {"id": patient_id, "status": "discharged",
                         "discharge_destination": "Ward 5"}),
                "discharge date",
                "Discharge without a date",
            )
            # ---- 1c. died without a date of death is rejected ----
            assert_rejected(
                call_fn(page, "updatePatient",
                        {"id": patient_id, "status": "died"}),
                "date of death",
                "Death without a date of death",
            )
            # None of the rejected writes changed the record.
            assert read_status(patient_id) == "admitted", (
                "a rejected status change still mutated the record"
            )

            # ---- 4. Same-status edit (no lifecycle change) is allowed ----
            same = call_fn(page, "updatePatient",
                           {"id": patient_id, "current_management": f"Updated {MARKER}"})
            assert same["ok"], f"same-status edit should be allowed: {same.get('error')}"

            # ---- 2. Legal transition admitted -> discharged with required fields ----
            ok = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": TODAY,
                "discharge_destination": "Ward 5",
            })
            assert ok["ok"], f"valid discharge should succeed: {ok.get('error')}"
            assert read_status(patient_id) == "discharged"

            # ---- 3. Illegal transition discharged -> admitted is rejected ----
            assert_rejected(
                call_fn(page, "updatePatient",
                        {"id": patient_id, "status": "admitted"}),
                "cannot become",
                "Reopening a discharged patient",
            )
            assert read_status(patient_id) == "discharged", (
                "an illegal transition still mutated the status"
            )

            # A same-status edit on the terminal record is still allowed.
            terminal_edit = call_fn(page, "updatePatient",
                                    {"id": patient_id, "current_management": f"Post {MARKER}"})
            assert terminal_edit["ok"], (
                f"editing a discharged record should still be allowed: {terminal_edit.get('error')}"
            )

            browser.close()

        print("PASS: server enforces status transitions and per-status required fields")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
