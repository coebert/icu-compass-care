"""
End-to-end test: viewing OR exporting a handover PDF requires authentication.

This feature added two handover-PDF surfaces that both live behind the
_authenticated route gate:

  - EXPORT: the per-patient "Handover PDF" button on /patients/<id>
  - VIEW:   the printable preview at /patients/handover-preview (embedded PDF
            viewer + "Download PDF")

This test proves the NEGATIVE path (logged out) and the POSITIVE path
(after login) for both surfaces:

  LOGGED OUT
    1. Deep-link to /patients/<id> redirects to /auth; the "Handover PDF"
       export button is never rendered.
    2. Deep-link to /patients/handover-preview redirects to /auth; neither the
       embedded preview iframe nor "Download PDF" is rendered.
    3. The server functions that feed both surfaces are rejected for an auth
       reason: getPatient(), listObservations(), listInvestigations(),
       listMicrobiology().

  AFTER LOGIN
    4. /patients/<id> renders the "Handover PDF" button and clicking it fires a
       .pdf download.
    5. /patients/handover-preview renders the preview and "Download PDF" fires a
       .pdf download.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-pdf-view-export-requires-auth.e2e.py
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

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
OBS_MODULE = "/src/lib/observations.functions.ts"
MICRO_MODULE = "/src/lib/microbiology.functions.ts"
INV_MODULE = "/src/lib/investigations.functions.ts"

MARKER = f"E2E-PDF-VIEW-GUARD-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "V.E.W."


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
    # Populate the fields the handover export validates as critical
    # (name, hospital number, location, current admission) so the export
    # button is enabled after login.
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "hospital_number": f"HN{int(time.time())}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            "current_admission": f"Admission {MARKER}",
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


def assert_auth_rejected(page, module, name, data):
    outcome = page.evaluate(CALL_SERVER_FN, {"module": module, "name": name, "data": data})
    assert not outcome["ok"], f"{name} succeeded while logged out — handover data leaked"
    assert "unauthor" in outcome["error"].lower(), (
        f"{name} rejected, but not for an auth reason: {outcome['error']}"
    )


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
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. EXPORT surface: /patients/<id> redirects to /auth ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            assert not page.get_by_role("button", name="Handover PDF").count(), (
                "Handover PDF export button rendered while logged out — export not blocked"
            )
            page.screenshot(path=str(SCREENSHOTS / "pdf_view_guard_detail_blocked.png"))

            # ---- 2. VIEW surface: /patients/handover-preview redirects to /auth ----
            page.goto(f"{BASE_URL}/patients/handover-preview", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), f"expected /auth, got {page.url}"
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "Download PDF control rendered while logged out — view not blocked"
            )
            assert not page.locator("iframe[title='Handover PDF preview']").count(), (
                "Preview iframe rendered while logged out — view not blocked"
            )
            page.screenshot(path=str(SCREENSHOTS / "pdf_view_guard_preview_blocked.png"))

            # ---- 3. All feeding server functions are rejected for an auth reason ----
            assert_auth_rejected(page, PATIENTS_MODULE, "getPatient", {"patientId": patient_id})
            assert_auth_rejected(page, OBS_MODULE, "listObservations", {"patientId": patient_id})
            assert_auth_rejected(page, INV_MODULE, "listInvestigations", {"patientId": patient_id})
            assert_auth_rejected(page, MICRO_MODULE, "listMicrobiology", {"patientId": patient_id})

            # ============ AFTER AUTHENTICATION ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 4. EXPORT: /patients/<id> renders the button; download fires ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            export_btn = page.get_by_role("button", name="Handover PDF")
            expect(export_btn).to_be_visible(timeout=15000)
            expect(export_btn).to_be_enabled()
            with page.expect_download(timeout=20000) as dl_info:
                export_btn.click()
            fname = dl_info.value.suggested_filename
            assert fname.lower().endswith(".pdf"), f"export did not produce a PDF: {fname!r}"
            page.screenshot(path=str(SCREENSHOTS / "pdf_view_guard_detail_downloaded.png"))

            # ---- 5. VIEW: /patients/handover-preview renders; download fires ----
            page.goto(f"{BASE_URL}/patients/handover-preview", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            download_btn = page.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=15000)
            expect(download_btn).to_be_enabled(timeout=15000)
            with page.expect_download(timeout=20000) as dl_info2:
                download_btn.click()
            fname2 = dl_info2.value.suggested_filename
            assert fname2.lower().endswith(".pdf"), f"preview download is not a PDF: {fname2!r}"
            page.screenshot(path=str(SCREENSHOTS / "pdf_view_guard_preview_downloaded.png"))

            browser.close()

        print(
            "PASS: handover PDF view + export blocked when logged out; "
            f"both download after auth ({fname}, {fname2})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
