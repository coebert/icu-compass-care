"""
End-to-end test: the handover PREVIEW and PDF DOWNLOAD surfaces require login.

This app builds the handover PDF client-side, but the download is now gated by a
server-side guard, `validateHandoverExport` (src/lib/handover.functions.ts),
which re-checks every patient's critical fields under `requireSupabaseAuth`. So
the two things a user relies on — "I can only VIEW the preview after login" and
"I can only DOWNLOAD a PDF after login" — are both auth-gated:

  - VIEW:     the printable preview at /patients/handover-preview (embedded PDF
              viewer + "Download PDF" button), which lives behind the
              _authenticated route gate.
  - DOWNLOAD: the "Download PDF" button awaits validateHandoverExport() before
              building the file — that server function IS the download gate.

This test proves both the NEGATIVE (logged out) and POSITIVE (after login)
paths:

  LOGGED OUT
    1. Deep-link to /patients/handover-preview redirects to /auth; neither the
       embedded preview iframe nor "Download PDF" is rendered.
    2. The download-guard server function validateHandoverExport() is REJECTED
       for an auth reason and returns no data.

  AFTER LOGIN
    3. validateHandoverExport() succeeds for a complete patient.
    4. /patients/handover-preview renders the preview and "Download PDF" fires a
       .pdf download.

A throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-validate-export-requires-auth.e2e.py
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

HANDOVER_MODULE = "/src/lib/handover.functions.ts"

MARKER = f"E2E-HANDOVER-GUARD-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "H.G.E."


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
    # Populate the fields validateHandoverExport treats as critical (name,
    # hospital number, location, current admission) so the guard PASSES after
    # login and the download can fire.
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 58,
            "hospital_number": f"HN{int(time.time())}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "4",
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


def call_guard(page, patient_id):
    return page.evaluate(
        CALL_SERVER_FN,
        {
            "module": HANDOVER_MODULE,
            "name": "validateHandoverExport",
            "data": {"patientIds": [patient_id]},
        },
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

            # ---- 1. VIEW surface: /patients/handover-preview -> /auth ----
            page.goto(
                f"{BASE_URL}/patients/handover-preview",
                wait_until="domcontentloaded",
            )
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected /auth, got {page.url}"
            )
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "Download PDF control rendered while logged out — view not blocked"
            )
            assert not page.locator("iframe[title='Handover PDF preview']").count(), (
                "Preview iframe rendered while logged out — view not blocked"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_guard_preview_blocked.png")
            )

            # ---- 2. DOWNLOAD guard endpoint rejected for an auth reason ----
            out = call_guard(page, patient_id)
            assert not out["ok"], (
                "validateHandoverExport succeeded while logged out — "
                "PDF download guard bypassed"
            )
            assert "unauthor" in out["error"].lower(), (
                "download guard rejected, but not for an auth reason: "
                f"{out['error']}"
            )
            assert patient_id not in out["error"] and MARKER not in out["error"], (
                f"download guard leaked patient data on rejection: {out['error']!r}"
            )
            print("OK  logged out: preview blocked + download guard rejected (Unauthorized)")

            # ============ AFTER AUTHENTICATION ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 3. Download guard now succeeds for a complete patient ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )
            out_authed = call_guard(page, patient_id)
            assert out_authed["ok"], (
                "validateHandoverExport failed while authenticated for a "
                f"complete patient: {out_authed.get('error')!r}"
            )

            # ---- 4. VIEW: /patients/handover-preview renders; download fires ----
            page.goto(
                f"{BASE_URL}/patients/handover-preview",
                wait_until="domcontentloaded",
            )
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            download_btn = page.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=15000)
            expect(download_btn).to_be_enabled(timeout=15000)
            with page.expect_download(timeout=20000) as dl_info:
                download_btn.click()
            fname = dl_info.value.suggested_filename
            assert fname.lower().endswith(".pdf"), (
                f"preview download is not a PDF: {fname!r}"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_guard_preview_downloaded.png")
            )

            browser.close()

        print(
            "PASS: handover preview + PDF download require login; "
            f"guard passes and download fires after auth ({fname})"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
