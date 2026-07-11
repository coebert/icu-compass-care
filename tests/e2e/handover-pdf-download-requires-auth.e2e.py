"""
End-to-end test: the DIRECT handover PDF download is denied when logged out and
succeeds after login.

The handover PDF is assembled in the browser, but the download is gated by a
server-side guard, `validateHandoverExport` (src/lib/handover.functions.ts),
which runs under `requireSupabaseAuth`. The client MUST await a successful guard
response before building/saving the file, so that server function IS the
download endpoint's authorization boundary. This test drives the real client
download path — guard call + `downloadHandover()` — and captures the resulting
file.

  LOGGED OUT
    1. Deep-link to /patients/handover-preview (the surface hosting the
       "Download PDF" control) redirects to /auth, so the endpoint is not even
       reachable from the UI.
    2. Invoking the download guard directly is REJECTED for an auth reason and
       leaks no patient data — a bypassed UI still cannot download.

  AFTER LOGIN
    3. The download guard succeeds for a complete patient.
    4. The full download path (await guard -> downloadHandover) fires a real
       browser download whose filename ends in .pdf and whose bytes are a valid
       PDF (start with "%PDF-").

A throwaway clinician user + a fully-populated patient are created and cleaned
up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-pdf-download-requires-auth.e2e.py
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

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
DOWNLOADS = Path(__file__).parent / "downloads"
DOWNLOADS.mkdir(parents=True, exist_ok=True)

HANDOVER_GUARD_MODULE = "/src/lib/handover.functions.ts"
HANDOVER_PDF_MODULE = "/src/lib/handover-pdf.ts"

MARKER = f"E2E-PDF-DL-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "P.D.L."


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
    # Populate every field validateHandoverExport treats as critical so the
    # guard PASSES after login and the download can fire.
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 61,
            "hospital_number": f"HN{int(time.time())}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "6",
            "status": "admitted",
            "current_admission": f"Admission {MARKER}",
            "current_management": f"Note {MARKER}",
        },
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


CALL_GUARD = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod.validateHandoverExport;
  try {
    const result = await fn({ data: { patientIds: arg.patientIds } });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""

# Runs the REAL download path: await the server guard, then build + save the PDF
# for a single, known-complete patient (avoids depending on the shared dataset
# being fully valid).
RUN_DOWNLOAD = """
async (arg) => {
  const guard = await import(arg.guardModule);
  const pdf = await import(arg.pdfModule);
  try {
    await guard.validateHandoverExport({ data: { patientIds: [arg.patient.id] } });
    pdf.downloadHandover([arg.patient], { title: "ICU Handover Sheet" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def main():
    user_id = patient = None
    try:
        user_id, email = create_user()
        patient = create_patient()
        patient_id = patient["id"]

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            # ============ LOGGED OUT ============
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Download surface deep-link redirects to /auth ----
            page.goto(
                f"{BASE_URL}/patients/handover-preview",
                wait_until="domcontentloaded",
            )
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth, got {page.url}"
            )
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "Download PDF control rendered while logged out"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_pdf_download_blocked.png")
            )

            # ---- 2. Direct download guard rejected (Unauthorized), no leak ----
            out = page.evaluate(
                CALL_GUARD,
                {"module": HANDOVER_GUARD_MODULE, "patientIds": [patient_id]},
            )
            assert not out["ok"], (
                "download guard succeeded while logged out — PDF download bypassed"
            )
            assert "unauthor" in out["error"].lower(), (
                f"download guard rejected, but not for an auth reason: {out['error']}"
            )
            assert patient_id not in out["error"] and MARKER not in out["error"], (
                f"download guard leaked patient data on rejection: {out['error']!r}"
            )
            print("OK  logged out: download surface redirects + guard Unauthorized")

            # ============ AFTER AUTHENTICATION ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 3. Guard succeeds for a complete patient ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )
            authed = page.evaluate(
                CALL_GUARD,
                {"module": HANDOVER_GUARD_MODULE, "patientIds": [patient_id]},
            )
            assert authed["ok"], (
                "download guard failed while authenticated for a complete "
                f"patient: {authed.get('error')!r}"
            )

            # ---- 4. Full download path fires a real .pdf download ----
            with page.expect_download(timeout=20000) as dl_info:
                result = page.evaluate(
                    RUN_DOWNLOAD,
                    {
                        "guardModule": HANDOVER_GUARD_MODULE,
                        "pdfModule": HANDOVER_PDF_MODULE,
                        "patient": patient,
                    },
                )
            assert result["ok"], (
                f"authenticated download path threw: {result.get('error')!r}"
            )
            download = dl_info.value
            assert download.suggested_filename.lower().endswith(".pdf"), (
                f"download is not a .pdf: {download.suggested_filename!r}"
            )
            saved = DOWNLOADS / download.suggested_filename
            download.save_as(str(saved))
            head = saved.read_bytes()[:5]
            assert head == b"%PDF-", (
                f"downloaded file is not a valid PDF (starts with {head!r})"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_pdf_download_allowed.png")
            )
            print(
                "OK  logged in: guard passes and a valid .pdf "
                f"({download.suggested_filename}) downloads"
            )

            browser.close()

        print(
            "PASS: direct handover PDF download is Unauthorized when logged out "
            "and produces a valid PDF after login"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient["id"] if patient else None, user_id)


if __name__ == "__main__":
    sys.exit(main())
