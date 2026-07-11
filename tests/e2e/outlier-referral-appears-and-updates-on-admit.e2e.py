"""
End-to-end test (UI-driven): a patient marked as a key outlying-ward referral
(location = outlier, status = referred) shows up in the board's "Outlying
wards / referrals" section, and that card reflects the status change when the
patient is admitted.

Flow:
  1. Seed a clinician user + a patient with location_type=outlier,
     status=referred, on a uniquely-named outlying ward (admin REST API); sign
     in.
  2. Open /patients and confirm the "Outlying wards / referrals" section lists
     this patient's card with the "Referred (outlier)" status badge and the
     seeded ward.
  3. Open the patient, go to the Status tab, change status to "Admitted", save.
  4. Confirm the DB now stores status=admitted (location stays outlier).
  5. Return to /patients: the patient still sits in the "Outlying wards /
     referrals" section, but the card now shows the "Admitted" badge and no
     longer shows "Referred (outlier)".

Throwaway user + patient are removed via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/outlier-referral-appears-and-updates-on-admit.e2e.py
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

STAMP = str(int(time.time()))
MARKER = f"E2E-OUTLIER-{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.W.R."
WARD_MARKER = f"Ward{STAMP}"

OUTLIER_HEADING = "Outlying wards / referrals"


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
            "age": 72,
            "location_type": "outlier",
            "ward": WARD_MARKER,
            "status": "referred",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=status,location_type",
        headers=admin_headers(),
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


def outlier_card(page, patient_id):
    """Locate this patient's card WITHIN the 'Outlying wards / referrals' section."""
    section = page.get_by_role("heading", name=OUTLIER_HEADING).first.locator(
        "xpath=ancestor::div[1]"
    )
    expect(section).to_be_visible(timeout=15000)
    card = section.locator(f'a[href$="/patients/{patient_id}"]').first
    expect(card).to_be_visible(timeout=15000)
    return card


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
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

            # ---- 1. Board shows the outlier in the outlying-wards section ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            card = outlier_card(page, patient_id)
            card_text = card.inner_text()
            assert "Referred (outlier)" in card_text, (
                f"outlier card missing 'Referred (outlier)' badge:\n{card_text!r}"
            )
            assert WARD_MARKER in card_text, (
                f"outlier card missing the seeded ward {WARD_MARKER!r}:\n{card_text!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "outlier_referred_on_board.png"))

            # ---- 2. Admit the patient via the Status tab ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            tab = page.get_by_role("tab", name="Status")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            panel = page.get_by_role("tabpanel")
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Admitted").click()
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            # ---- 3. DB reflects admitted; still an outlier location ----
            row = read_patient(patient_id)
            assert row["status"] == "admitted", f"status not admitted: {row!r}"
            assert row["location_type"] == "outlier", (
                f"location should stay outlier: {row!r}"
            )

            # ---- 4. Board: same section, card now shows 'Admitted' ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            card = outlier_card(page, patient_id)
            expect(card).to_contain_text("Admitted", timeout=10000)
            updated_text = card.inner_text()
            assert "Referred (outlier)" not in updated_text, (
                f"card still shows the stale 'Referred (outlier)' badge:\n{updated_text!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "outlier_admitted_on_board.png"))

            browser.close()

        print(
            "PASS: outlying-ward referral appears in the outlying-wards section and its "
            "card updates from 'Referred (outlier)' to 'Admitted' after admission"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
