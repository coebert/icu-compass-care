"""
End-to-end test: the patient DETAIL route /patients/<id> is fully blocked when
logged out — both the route itself (redirects to /auth) and the record data
behind it (getPatient rejected for an auth reason).

Complements:
  - auth-access-control.e2e.py  — board route + view/edit boundary via RPC.
  - patient-detail-edit.e2e.py  — positive path: detail page loads + edits after auth.

This test proves the NEGATIVE path for the detail screen specifically: a
deep-link straight to /patients/<id> must NOT render the detail UI for an
unauthenticated visitor.

What it asserts:
  1. ROUTE blocked — logged out, /patients/<id> redirects to /auth.
  2. UI not leaked — the patient's name / detail tabs never render on that page.
  3. DATA blocked  — getPatient(<id>) is rejected with an auth error.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-detail-auth-guard.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"
MARKER = f"E2E-DETAIL-GUARD-{int(time.time())}"
PATIENT_NAME = "Q.X."


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 58,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


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
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # No session is ever restored — this visitor is logged out.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Deep-link to the detail route redirects to /auth ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"

            # ---- 2. The detail UI must not have leaked ----
            assert not page.get_by_text(PATIENT_NAME, exact=False).count(), (
                "patient name rendered on a logged-out detail page — UI leaked"
            )
            assert not page.get_by_role("tab", name="Overview").count(), (
                "detail record tabs rendered while logged out — UI leaked"
            )
            page.screenshot(path=str(SCREENSHOTS / "detail_guard_blocked.png"))

            # ---- 3. The record data behind the detail page is rejected ----
            outcome = page.evaluate(
                CALL_SERVER_FN,
                {"module": FUNCTIONS_MODULE, "name": "getPatient", "data": {"id": patient_id}},
            )
            assert not outcome["ok"], "getPatient succeeded while logged out — data leaked"
            assert "unauthor" in outcome["error"].lower(), (
                f"getPatient rejected, but not for an auth reason: {outcome['error']}"
            )

            browser.close()

        print("PASS: /patients/<id> route + detail UI + record data all blocked when logged out")
        return 0
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
