"""
End-to-end test: while UNAUTHENTICATED, attempting to open the History page and
download a saved handover PDF exposes NO patient content or markers anywhere.

The History surface (src/routes/_authenticated/patients.history.tsx) lives under
the auth-gated `_authenticated` layout, and every data path is a server function
behind `requireSupabaseAuth` (src/lib/handover-versions.functions.ts). The PDF
download is built client-side from data returned by getHandoverVersion — so with
no session there is simply nothing to render or download.

To make the test meaningful we first seed REAL, sensitive content that MUST NOT
leak: a marker-bearing patient and a saved handover version whose snapshot and
search_text contain that marker. Then, logged out, we assert:

  1. Deep-linking to /patients/history redirects to /auth; the "Save version
     now" and "Download PDF" controls never render.
  2. listHandoverVersions is REJECTED (Unauthorized) and leaks no marker.
  3. getHandoverVersion for the seeded version is REJECTED and leaks no marker.
  4. The entire rendered DOM (auth page) contains none of the seeded markers.

A throwaway patient + saved version are created and cleaned up via the Supabase
admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/history-download-logged-out-no-leak.e2e.py
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
SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

VERSIONS_MODULE = "/src/lib/handover-versions.functions.ts"

STAMP = str(int(time.time()))
MARKER = f"NOLEAK{STAMP}"
PATIENT_NAME = f"Confidential {MARKER}"
MANAGEMENT = f"Sensitive management plan {MARKER}"
# Every marker below must be absent from the logged-out DOM and every response.
MARKERS = [MARKER, PATIENT_NAME, MANAGEMENT]


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
            "age": 55,
            "hospital_number": f"HN{STAMP}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "3",
            "status": "admitted",
            "current_management": MANAGEMENT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def create_version(patient_row):
    """Seed a saved handover version whose snapshot + search_text carry the
    marker, mirroring what a real capture would store."""
    today = datetime.now(timezone.utc).date().isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": today,
            "shift": "day",
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


CALL_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn(arg.data ? { data: arg.data } : undefined);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def assert_no_markers(haystack, where):
    for m in MARKERS:
        assert m not in haystack, f"{where} leaked marker {m!r}"


def main():
    patient_id = version_id = None
    try:
        patient = create_patient()
        patient_id = patient["id"]
        version_id = create_version(patient)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            # Never authenticate. Land on the app first (public).
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. History deep-link redirects to /auth; controls absent ----
            page.goto(f"{BASE_URL}/patients/history", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth, got {page.url}"
            )
            page.wait_for_load_state("networkidle")
            assert not page.get_by_role("button", name="Save version now").count(), (
                "Save version now control rendered while logged out"
            )
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "Download PDF control rendered while logged out"
            )

            # ---- 2. listHandoverVersions rejected, no leak ----
            listed = page.evaluate(
                CALL_FN,
                {"module": VERSIONS_MODULE, "name": "listHandoverVersions", "data": {}},
            )
            assert not listed["ok"], "listHandoverVersions succeeded while logged out"
            assert "unauthor" in listed["error"].lower(), (
                f"list rejected but not for auth: {listed['error']}"
            )
            assert_no_markers(listed["error"], "listHandoverVersions error")

            # Also try a marker search — must not surface the seeded version.
            searched = page.evaluate(
                CALL_FN,
                {
                    "module": VERSIONS_MODULE,
                    "name": "listHandoverVersions",
                    "data": {"q": MARKER},
                },
            )
            assert not searched["ok"], "marker search succeeded while logged out"
            assert_no_markers(json.dumps(searched), "listHandoverVersions marker search")

            # ---- 3. getHandoverVersion for the seeded id rejected, no leak ----
            got = page.evaluate(
                CALL_FN,
                {
                    "module": VERSIONS_MODULE,
                    "name": "getHandoverVersion",
                    "data": {"id": version_id},
                },
            )
            assert not got["ok"], "getHandoverVersion succeeded while logged out"
            assert "unauthor" in got["error"].lower(), (
                f"get rejected but not for auth: {got['error']}"
            )
            assert_no_markers(json.dumps(got), "getHandoverVersion result/error")

            # ---- 4. Whole rendered DOM carries no marker ----
            dom = page.content()
            assert_no_markers(dom, "logged-out DOM")
            page.screenshot(
                path=str(SCREENSHOTS / "history_download_logged_out_no_leak.png")
            )

            browser.close()

        print(
            "PASS: logged out, History redirects to /auth and version list/get/"
            "download expose no patient content or markers"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
