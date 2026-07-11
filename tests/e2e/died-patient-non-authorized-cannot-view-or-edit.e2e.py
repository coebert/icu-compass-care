"""
End-to-end test: a NON-AUTHORIZED (logged-out) user cannot view OR edit any
fields on a DIED patient record.

In this app there is no public sign-up — every clinical surface is behind auth,
and all data access goes through server functions guarded by requireSupabaseAuth.
A "non-authorized user" is therefore an unauthenticated visitor. Died records are
retained (never hard-deleted), so they must be protected exactly like live ones.

What it asserts, for a died patient specifically:
  1. ROUTE blocked   — /patients/<id> redirects to /auth when logged out.
  2. UI not leaked    — the died patient's name, "Died" status, and detail tabs
                        never render on that page.
  3. READ blocked     — getPatient(<id>) is rejected with an auth error.
  4. WRITE blocked    — updatePatient(<id>, ...) is rejected with an auth error,
                        and the record in the database is unchanged afterwards.

A throwaway died patient is created and cleaned up via the Supabase admin REST
API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/died-patient-non-authorized-cannot-view-or-edit.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"
MARKER = f"E2E-DIED-GUARD-{int(time.time())}"
PATIENT_NAME = "Z.D."
ORIGINAL_NOTE = f"Original {MARKER}"
DEATH_DATE = "2026-01-05"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_died_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "died",
            "date_of_death": DEATH_DATE,
            "current_management": ORIGINAL_NOTE,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,current_management,date_of_death",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
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


def main():
    patient_id = None
    try:
        patient_id = create_died_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # No session is ever restored — this visitor is non-authorized.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Deep-link to the died record's detail route redirects to /auth ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"

            # ---- 2. No died-record UI may leak ----
            assert not page.get_by_text(PATIENT_NAME, exact=False).count(), (
                "died patient name rendered on a logged-out page — UI leaked"
            )
            assert not page.get_by_text("Died", exact=False).count(), (
                "died status leaked on a logged-out page — UI leaked"
            )
            assert not page.get_by_role("tab", name="Overview").count(), (
                "detail record tabs rendered while logged out — UI leaked"
            )
            assert not page.get_by_role("button", name="Edit").count(), (
                "Edit control rendered while logged out — edit surface leaked"
            )
            page.screenshot(path=str(SCREENSHOTS / "died_non_authorized_blocked.png"))

            # ---- 3. Reading the died record is rejected ----
            read = page.evaluate(
                CALL_SERVER_FN,
                {"module": FUNCTIONS_MODULE, "name": "getPatient", "data": {"id": patient_id}},
            )
            assert not read["ok"], "getPatient succeeded while logged out — read leaked"
            assert "unauthor" in read["error"].lower(), (
                f"getPatient rejected, but not for an auth reason: {read['error']}"
            )

            # ---- 4. Editing any field on the died record is rejected ----
            write = page.evaluate(
                CALL_SERVER_FN,
                {
                    "module": FUNCTIONS_MODULE,
                    "name": "updatePatient",
                    "data": {"id": patient_id, "current_management": f"HACKED {MARKER}"},
                },
            )
            assert not write["ok"], "updatePatient succeeded while logged out — write allowed"
            assert "unauthor" in write["error"].lower(), (
                f"updatePatient rejected, but not for an auth reason: {write['error']}"
            )

            browser.close()

        # ---- 4b. The record is byte-for-byte unchanged after the blocked write ----
        after = read_patient(patient_id)
        assert after is not None, "died patient row vanished during the test"
        assert after["status"] == "died", f"status changed to {after['status']}"
        assert after["current_management"] == ORIGINAL_NOTE, (
            f"current_management was mutated by an unauthorized write: {after['current_management']!r}"
        )
        assert str(after["date_of_death"]).startswith(DEATH_DATE), (
            f"date_of_death changed: {after['date_of_death']!r}"
        )

        print("PASS: non-authorized user blocked from viewing and editing the died patient record")
        return 0
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
