"""
End-to-end test: outlying-ward / critical-care referral flag persists.

Drives the real ICU handover app in a headless browser as an authenticated
clinician/admin and exercises the referral (outlier) lifecycle on a single
patient:

  1. MARK        — open an admitted ICU patient, edit it, set Location to
     "Outlying ward / referral" and Status to "Referred (outlier)", record a
     ward, and save.
  2. PERSIST (UI) — hard-reload the record, reopen the edit form, and confirm
     Location, Status and the ward are still set to the referral values.
  3. PERSIST (SYNC) — pull the patient through the cross-project bridge
     endpoint (GET /api/public/bridge/patients, HMAC-signed as the partner
     app would) and confirm the partner sees location_type=outlier and
     status=referred with the same ward.
  4. EDITABLE    — change the ward on the still-referral record, save, reload,
     and confirm the new ward persisted while the flag stayed on outlier, in
     both the UI and partner sync.

The patient row and the throwaway admin user are created and removed via the
Supabase admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/referral-outlier-persistence.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
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
BRIDGE_SECRET = os.environ["HANDOVER_API_SECRET"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"OUTLR{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

WARD = f"{MARKER}-WARD-A"
WARD_2 = f"{MARKER}-WARD-B"  # edited value after referral

LOCATION_LABEL = "Outlying ward / referral"
STATUS_LABEL = "Referred (outlier)"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
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
        json={"user_id": uid, "role": "admin"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": "E2E OUTL",
            "age": 47,
            "location_type": "icu",
            "status": "admitted",
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


def cleanup(user_id, patient_id):
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


def bridge_get_patient(patient_id):
    """Fetch patients as the partner app would: HMAC-signed GET, then filter."""
    actor = json.dumps(
        {"id": "00000000-0000-0000-0000-000000000000", "email": "partner@care.test", "role": "clinician"}
    )
    ts = str(int(time.time()))
    sig = hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{actor}.".encode(), hashlib.sha256
    ).hexdigest()
    r = requests.get(
        f"{BASE_URL}/api/public/bridge/patients",
        headers={"x-timestamp": ts, "x-actor": actor, "x-signature": sig},
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()["patients"]
    return next((p for p in rows if p["id"] == patient_id), None)


# ---- UI helpers -------------------------------------------------------------

def open_edit(page):
    page.get_by_role("button", name="Edit").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=15000)
    return dialog


def select_field(dialog, label):
    """The shadcn Select trigger (combobox) that follows a Field <label>."""
    return dialog.get_by_text(label, exact=True).locator(
        "xpath=following-sibling::button"
    )


def ward_input(dialog):
    return dialog.get_by_text("Ward", exact=True).locator("xpath=following-sibling::input")


def choose_option(dialog, name):
    dialog.page.get_by_role("option", name=name).click()


def save(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)


def reload_patient(page, patient_id):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"


def main():
    user_id = None
    patient_id = None
    try:
        user_id, email = create_admin_user()
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

            reload_patient(page, patient_id)

            # ---- 1. MARK as outlying-ward / critical-care referral ----
            dialog = open_edit(page)
            select_field(dialog, "Location").click()
            choose_option(dialog, LOCATION_LABEL)
            select_field(dialog, "Status").click()
            choose_option(dialog, STATUS_LABEL)
            ward_input(dialog).fill(WARD)
            save(page, dialog)
            page.screenshot(path=str(SCREENSHOTS / "referral_1_marked.png"))

            # ---- 2. PERSIST after reload (UI) ----
            reload_patient(page, patient_id)
            dialog = open_edit(page)
            expect(select_field(dialog, "Location")).to_contain_text(LOCATION_LABEL, timeout=15000)
            expect(select_field(dialog, "Status")).to_contain_text(STATUS_LABEL)
            expect(ward_input(dialog)).to_have_value(WARD)
            page.screenshot(path=str(SCREENSHOTS / "referral_2_persisted.png"))
            # Close the dialog before the sync check.
            dialog.get_by_role("button", name="Cancel").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            # ---- 3. PERSIST after partner sync (bridge pull) ----
            row = bridge_get_patient(patient_id)
            assert row is not None, "partner sync did not return the referral patient"
            assert row["location_type"] == "outlier", f"partner location != outlier: {row['location_type']}"
            assert row["status"] == "referred", f"partner status != referred: {row['status']}"
            assert row["ward"] == WARD, f"partner ward mismatch: {row['ward']!r}"

            # ---- 4. STILL EDITABLE on the referral record ----
            dialog = open_edit(page)
            ward = ward_input(dialog)
            expect(ward).to_have_value(WARD, timeout=15000)
            ward.fill(WARD_2)
            save(page, dialog)

            reload_patient(page, patient_id)
            dialog = open_edit(page)
            expect(select_field(dialog, "Location")).to_contain_text(LOCATION_LABEL, timeout=15000)
            expect(ward_input(dialog)).to_have_value(WARD_2)
            page.screenshot(path=str(SCREENSHOTS / "referral_3_edited.png"))

            # Confirm the edit propagated to the partner and the flag held.
            row = bridge_get_patient(patient_id)
            assert row and row["location_type"] == "outlier" and row["ward"] == WARD_2, (
                f"partner did not see edited referral ward / flag: {row}"
            )

            browser.close()

        print(
            "PASS: referral (outlier) flag recorded, persisted through reload "
            "and partner sync, and remained editable"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
