"""
End-to-end test: while LOGGED OUT, every route and endpoint that can turn a
patient's saved handover into a PDF — the compare view, the history/download
view, the handover-preview view, and the underlying version/patient/export
server functions — refuses the request and never returns patient content.

This covers the "compare/PDF URLs" surfaces specifically:

  UI (deep-linked with no session):
    /patients/compare               (compare two versions -> export/diff)
    /patients/history               (browse + Download PDF of a saved version)
    /patients/handover-preview      (live preview + Download PDF)
    /patients/{id}                  (single-patient handover export controls)
  Each must redirect to /auth, render no Download/PDF controls, and leak no
  seeded patient marker into the DOM.

  Server functions (invoked from the page with NO bearer attached):
    getPatient, listHandoverVersions, getHandoverVersion, validateHandoverExport
  Each must reject for an auth reason and carry no patient marker in the error.

To make "no leak" meaningful we first seed a REAL, marker-bearing patient and a
saved handover version whose snapshot + search_text carry the same markers, so
if any surface rendered the data a marker would appear.

Throwaway patient + version are created and cleaned up via the Supabase admin
REST API. No user is ever created — the whole point is the logged-out view.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/pdf-compare-download-logged-out-no-leak.e2e.py
Exits 0 on success, non-zero on failure.
"""

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

STAMP = str(int(time.time()))
MARKER = f"PDFNOLEAK{STAMP}"
PATIENT_NAME = f"PdfSecret {MARKER}"
MANAGEMENT = f"Confidential mgmt {MARKER}"
HOSPITAL_NUMBER = f"HN{STAMP}"
MARKERS = [MARKER, PATIENT_NAME, MANAGEMENT, HOSPITAL_NUMBER]

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
VERSIONS_MODULE = "/src/lib/handover-versions.functions.ts"
HANDOVER_MODULE = "/src/lib/handover.functions.ts"

# Invoke a server function from the page using the real TanStack client
# transport. With no session in localStorage, no bearer token is attached, so
# requireSupabaseAuth rejects — exactly the logged-out attacker path.
CALL_SERVER_FN = """
async (arg) => {
  try {
    const mod = await import(arg.module);
    const fn = mod[arg.name];
    const result = await fn({ data: arg.data });
    return { ok: true, result: JSON.stringify(result) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


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
            "age": 66,
            "hospital_number": HOSPITAL_NUMBER,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            "current_admission": f"Admission {MARKER}",
            "current_management": MANAGEMENT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def create_version(patient_row):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": datetime.now(timezone.utc).date().isoformat(),
            "shift": "am",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "label": f"Seed version {MARKER}",
            "patient_count": 1,
            "snapshot": [patient_row],
            "search_text": f"{PATIENT_NAME} {MANAGEMENT} {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def cleanup(patient_id, version_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )


def dom_leaks(page):
    haystack = page.evaluate(
        """() => [
             document.documentElement.outerHTML,
             document.body ? document.body.innerText : '',
             document.title,
           ].join('\\n')"""
    )
    return [m for m in MARKERS if m in haystack]


def assert_route_blocked(page, path, slug):
    page.goto(f"{BASE_URL}{path}", wait_until="domcontentloaded")
    page.wait_for_url("**/auth", timeout=15000)
    assert page.url.rstrip("/").endswith("/auth"), f"{path}: expected /auth, got {page.url}"
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(600)
    assert not page.get_by_role("button", name="Download PDF").count(), (
        f"{path}: a 'Download PDF' control rendered while logged out"
    )
    leaks = dom_leaks(page)
    assert not leaks, f"{path}: leaked patient markers while logged out: {leaks}"
    page.screenshot(path=str(SCREENSHOTS / f"pdf_logged_out_{slug}.png"))
    print(f"OK  {path}: redirected to /auth, no PDF controls, no leak")


def assert_fn_rejected(page, module, name, data):
    out = page.evaluate(CALL_SERVER_FN, {"module": module, "name": name, "data": data})
    assert not out["ok"], f"{name}: succeeded while logged out — auth guard bypassed"
    assert "unauthor" in out["error"].lower(), (
        f"{name}: rejected but not for an auth reason: {out['error']!r}"
    )
    leaked = [m for m in MARKERS if m in out["error"]]
    assert not leaked, f"{name}: leaked patient markers on rejection: {leaked}"
    print(f"OK  {name}: unauthenticated call rejected (Unauthorized); no data leaked")


def main():
    patient_id = version_id = None
    try:
        patient = create_patient()
        patient_id = patient["id"]
        version_id = create_version(patient)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800}, accept_downloads=True
            )
            page = context.new_page()

            # Establish the origin — never write a session to localStorage.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- UI: every PDF/compare surface is gated behind login ----
            assert_route_blocked(page, "/patients/compare", "compare")
            assert_route_blocked(page, "/patients/history", "history")
            assert_route_blocked(page, "/patients/handover-preview", "preview")
            assert_route_blocked(page, f"/patients/{patient_id}", "detail")

            # ---- Server functions: rejected with no bearer, no content ----
            assert_fn_rejected(page, PATIENTS_MODULE, "getPatient", {"id": patient_id})
            assert_fn_rejected(page, VERSIONS_MODULE, "listHandoverVersions", {})
            assert_fn_rejected(page, VERSIONS_MODULE, "getHandoverVersion", {"id": version_id})
            assert_fn_rejected(
                page, HANDOVER_MODULE, "validateHandoverExport", {"patientIds": [patient_id]}
            )

            browser.close()

        print("PASS: logged-out PDF/compare/download surfaces rejected; no patient content returned")
        return 0
    finally:
        cleanup(patient_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
