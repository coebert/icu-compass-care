"""
End-to-end test: attempting to reach the handover History page (where saved
handover versions are downloaded as PDFs) while LOGGED OUT must redirect to
/auth, render no download controls, and leak no patient data into the DOM.

The History page (/patients/history) lives under the _authenticated layout, so
the route gate is the first line of defence. This test proves the gate holds AND
that nothing sensitive renders behind it:

  1. Seed a real, marker-bearing patient and a saved handover version whose
     snapshot + search_text carry the same markers — so if the page rendered any
     version data, a marker would appear.
  2. With NO session ever restored, deep-link to /patients/history.
  3. Assert the redirect lands on /auth.
  4. Assert no "Download PDF" / "Save version now" controls render.
  5. Assert not a single seeded marker appears anywhere in the DOM
     (outerHTML + innerText + <title>).

The throwaway patient + version are created and removed via the Supabase admin
REST API. No user is created — the whole point is the logged-out view.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/history-pdf-download-logged-out-redirect.e2e.py
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
MARKER = f"HISTNOLEAK{STAMP}"
PATIENT_NAME = f"HistSecret {MARKER}"
MANAGEMENT = f"Confidential mgmt {MARKER}"
HOSPITAL_NUMBER = f"HN{STAMP}"
MARKERS = [MARKER, PATIENT_NAME, MANAGEMENT, HOSPITAL_NUMBER]


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
            "hospital_number": HOSPITAL_NUMBER,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "4",
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


def find_leaks(page):
    haystack = page.evaluate(
        """() => [
             document.documentElement.outerHTML,
             document.body ? document.body.innerText : '',
             document.title,
           ].join('\\n')"""
    )
    return [m for m in MARKERS if m in haystack]


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

            # Establish the origin — never write a session to localStorage.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- Deep-link to the History page while logged out ----
            page.goto(f"{BASE_URL}/patients/history", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth, got {page.url}"
            )
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1000)

            # ---- No download / version controls may render ----
            assert not page.get_by_role("button", name="Download PDF").count(), (
                "a 'Download PDF' control rendered while logged out"
            )
            assert not page.get_by_role("button", name="Save version now").count(), (
                "a 'Save version now' control rendered while logged out"
            )

            # ---- No seeded marker anywhere in the DOM ----
            leaks = find_leaks(page)
            assert not leaks, (
                f"patient data leaked into the History DOM while logged out: {leaks}"
            )

            page.screenshot(
                path=str(SCREENSHOTS / "history_pdf_download_logged_out_redirect.png")
            )
            browser.close()

        print(
            "PASS: logged-out /patients/history redirects to /auth with no "
            "download controls and no patient data in the DOM"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
