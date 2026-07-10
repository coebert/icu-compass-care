"""
End-to-end test: the patient page's "Most recent investigations" section shows
the NEWEST value per category, even when entries are saved out of chronological
order.

The Overview tab renders one card per key category (Bloods / CXR / CT chest)
showing the newest finding by result_at (see RecentInvestigations in
src/routes/_authenticated/patients.$patientId.tsx, backed by
mostRecentInvestigation in src/lib/handover-pdf.ts). This test:

  1. Seeds a patient, then adds investigations OUT OF ORDER — for every
     category the OLDER entry is inserted AFTER the newer one — so a naive
     "last saved wins" implementation would show the wrong value.
  2. Restores a clinician session and opens the patient page.
  3. Asserts the Overview "Most recent investigations" cards show each
     category's NEWEST finding and NOT the superseded older ones.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/recent-investigations-ordering.e2e.py
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

MARKER = f"E2ERECINV{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "R.E.C."

SUFFIX = str(int(time.time()))[-6:]
# Per category: (old finding, new finding). Old is inserted AFTER new.
CASES = {
    "Bloods": (f"BOLD{SUFFIX}", f"BNEW{SUFFIX}"),
    "CXR": (f"CXOLD{SUFFIX}", f"CXNEW{SUFFIX}"),
    "CT chest": (f"CTOLD{SUFFIX}", f"CTNEW{SUFFIX}"),
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
            "age": 63,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_investigation(patient_id, category, findings, result_at):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "category": category,
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
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}",
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
        for category, (old, new) in CASES.items():
            add_investigation(patient_id, category, new, (now - timedelta(hours=1)).isoformat())
            add_investigation(patient_id, category, old, (now - timedelta(days=3)).isoformat())

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

            # Overview tab is the default; the "Most recent investigations" card lives here.
            section = page.get_by_text("Most recent investigations", exact=False).first
            expect(section).to_be_visible(timeout=15000)

            # Wait for the newest Bloods finding to render (proves data loaded).
            expect(page.get_by_text(CASES["Bloods"][1], exact=False).first).to_be_visible(timeout=15000)

            page.screenshot(path=str(SCREENSHOTS / f"recent_investigations_{MARKER}.png"))

            body_text = page.locator("body").inner_text()
            browser.close()

        packed = "".join(body_text.split())

        for category, (old, new) in CASES.items():
            assert new in packed, f"{category}: newest finding '{new}' not shown on patient page"
            assert old not in packed, (
                f"{category}: superseded older finding '{old}' is shown — "
                "most-recent selection ignored result_at ordering"
            )

        print("PASS: patient page shows newest per-category investigations after out-of-order saves")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
