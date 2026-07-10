"""
End-to-end test: microbiology results on the patient page.

The Microbiology tab (MicrobiologyTab in
src/routes/_authenticated/patients.$patientId.tsx) shows, per specimen type,
a "Latest <specimen type>" card with the NEWEST result by result_at, plus a
"Full history" list that keeps every entry (older ones remain accessible).

This test:

  1. Seeds a patient, then adds microbiology results OUT OF ORDER — for every
     specimen type the OLDER entry is inserted AFTER the newer one — so a naive
     "last saved wins" implementation would surface the wrong "latest".
  2. Restores a clinician session and opens the patient page's Microbiology tab.
  3. Asserts each specimen type's "Latest" card shows the NEWEST finding and
     NOT the superseded older one.
  4. Asserts the "Full history" list still contains BOTH the newest and the
     older findings (older entries remain accessible).

Throwaway clinician user + patient (+microbiology) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/microbiology-newest-and-history.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
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

MARKER = f"E2EMICRO{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.I.C."

SUFFIX = str(int(time.time()))[-6:]
# Per specimen type: (old finding, new finding). Old is inserted AFTER new.
CASES = {
    "Blood culture": (f"BCOLD{SUFFIX}", f"BCNEW{SUFFIX}"),
    "Respiratory (sputum / BAL)": (f"RSOLD{SUFFIX}", f"RSNEW{SUFFIX}"),
    "Urine": (f"UROLD{SUFFIX}", f"URNEW{SUFFIX}"),
}

now = datetime.now(timezone.utc)


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
            "age": 58,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_microbiology(patient_id, specimen_type, findings, result_at):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "specimen_type": specimen_type,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    )
    r.raise_for_status()


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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # Insert OUT OF ORDER: the NEWER result first, then the OLDER one.
        for specimen, (old, new) in CASES.items():
            add_microbiology(patient_id, specimen, new, (now - timedelta(hours=1)).isoformat())
            add_microbiology(patient_id, specimen, old, (now - timedelta(days=4)).isoformat())

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

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # Open the Microbiology tab.
            page.get_by_role("tab", name="Microbiology").click()

            # The "Key microbiology results" heading confirms the tab rendered.
            expect(page.get_by_text("Key microbiology results", exact=False).first).to_be_visible(timeout=15000)

            # Wait for the newest blood-culture finding to render (proves data loaded).
            expect(page.get_by_text(CASES["Blood culture"][1], exact=False).first).to_be_visible(timeout=15000)

            page.screenshot(path=str(SCREENSHOTS / f"microbiology_{MARKER}.png"))

            # "Latest <specimen>" cards region — everything before "Full history".
            full_body = page.locator("body").inner_text()
            browser.close()

        packed = "".join(full_body.split())

        # Full history keeps BOTH the newest and the older entries.
        for specimen, (old, new) in CASES.items():
            assert new in packed, f"{specimen}: newest finding '{new}' not shown"
            assert old in packed, (
                f"{specimen}: older finding '{old}' missing — older entries should "
                "remain accessible in the full history"
            )

        # The "Latest" cards must show the newest finding for each specimen type.
        # Split on the "Full history" heading: text before it is the latest cards.
        head = full_body.split("Full history")[0]
        head_packed = "".join(head.split())
        for specimen, (old, new) in CASES.items():
            assert new in head_packed, (
                f"{specimen}: newest finding '{new}' not shown in the 'Latest' cards"
            )
            assert old not in head_packed, (
                f"{specimen}: superseded older finding '{old}' shown as latest — "
                "newest-per-specimen selection ignored result_at ordering"
            )

        print("PASS: microbiology shows newest per specimen type; older entries remain in history")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
