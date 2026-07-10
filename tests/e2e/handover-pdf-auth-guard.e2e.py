"""
End-to-end test: exporting the handover PDF is blocked until authentication.

The handover sheet is generated on the board route /patients (Preview PDF ->
Download PDF), which lives entirely behind the _authenticated route gate. This
test proves the NEGATIVE path (logged out) and the POSITIVE path (after login):

  1. LOGGED OUT — a deep-link to /patients redirects to /auth, so the
     "Preview PDF" export control is never rendered and no PDF can be produced.
  2. DATA blocked — listPatients() (which feeds the export) is rejected for an
     auth reason while logged out.
  3. AFTER LOGIN — /patients renders, "Preview PDF" opens the modal, and
     "Download PDF" actually triggers a .pdf download.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-pdf-auth-guard.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
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

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"
MARKER = f"E2E-PDF-GUARD-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "P.D.F."


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
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            # ============ LOGGED OUT ============
            # No session restored — this visitor is unauthenticated.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. /patients deep-link redirects to /auth ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"

            # The export controls must never render on the auth screen.
            assert not page.get_by_role("button", name="Preview PDF").count(), (
                "Preview PDF export control rendered while logged out — export not blocked"
            )
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "Download PDF control rendered while logged out — export not blocked"
            )
            page.screenshot(path=str(SCREENSHOTS / "pdf_guard_blocked.png"))

            # ---- 2. The patient data that feeds the export is rejected ----
            outcome = page.evaluate(
                CALL_SERVER_FN,
                {"module": FUNCTIONS_MODULE, "name": "listPatients", "data": {}},
            )
            assert not outcome["ok"], "listPatients succeeded while logged out — export data leaked"
            assert "unauthor" in outcome["error"].lower(), (
                f"listPatients rejected, but not for an auth reason: {outcome['error']}"
            )

            # ============ AFTER AUTHENTICATION ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # ---- 3. Export control now reachable; download actually fires ----
            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_visible(timeout=15000)
            expect(preview_btn).to_be_enabled()
            preview_btn.click()

            dialog = page.get_by_role("dialog")
            download_btn = dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            fname = download.suggested_filename
            assert fname.lower().endswith(".pdf"), f"downloaded file is not a PDF: {fname!r}"
            page.screenshot(path=str(SCREENSHOTS / "pdf_guard_downloaded.png"))

            browser.close()

        print(f"PASS: PDF export blocked when logged out; downloads after auth ({fname})")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
