"""
End-to-end test: discharge status + destination survive partner sync and stay editable.

Drives the real ICU handover app in a headless browser as an authenticated
clinician/admin and exercises the discharge lifecycle on a single patient:

  1. DISCHARGE   — open an admitted patient, go to the Status tab, set the
     status to "Discharged" and record a discharge destination, then save.
  2. PERSIST (UI) — hard-reload the record and confirm the Status tab still
     shows "Discharged" and the recorded destination.
  3. PERSIST (SYNC) — pull the patient through the cross-project bridge
     endpoint (GET /api/public/bridge/patients, HMAC-signed as the partner
     app would) and confirm the partner sees status=discharged with the same
     discharge_destination.
  4. EDITABLE    — change the discharge destination on the now-discharged
     record, save, reload, and confirm the new destination persisted while
     the old value is gone.

The patient row and the throwaway admin user are created and removed via the
Supabase admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/discharge-status-persistence.e2e.py
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

MARKER = f"DISCH{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

DESTINATION = f"{MARKER}-WARD-5"
DESTINATION_2 = f"{MARKER}-HOME"  # edited value after discharge


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
            "full_name": "E2E DISCH",
            "age": 58,
            "location_type": "icu",
            "bed": "3",
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

def open_status_tab(page):
    page.get_by_role("tab", name="Status").click()
    panel = page.get_by_role("tabpanel")
    expect(panel.get_by_text("Patient status", exact=True)).to_be_visible(timeout=15000)
    return panel


def destination_input(panel):
    return panel.get_by_text("Discharge destination", exact=True).locator(
        "xpath=following-sibling::input"
    )


def set_status_discharged(panel):
    panel.get_by_role("combobox").click()
    panel.page.get_by_role("option", name="Discharged").click()


def update_status(page, panel):
    panel.get_by_role("button", name="Update status").click()
    expect(page.get_by_text("Status updated", exact=False).first).to_be_visible(timeout=15000)


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

            # ---- 1. DISCHARGE the patient ----
            panel = open_status_tab(page)
            set_status_discharged(panel)
            dest = destination_input(panel)
            expect(dest).to_be_visible(timeout=15000)
            dest.fill(DESTINATION)
            update_status(page, panel)
            page.screenshot(path=str(SCREENSHOTS / "discharge_1_set.png"))

            # ---- 2. PERSIST after reload (UI) ----
            reload_patient(page, patient_id)
            panel = open_status_tab(page)
            expect(panel.get_by_role("combobox")).to_contain_text("Discharged", timeout=15000)
            expect(destination_input(panel)).to_have_value(DESTINATION, timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "discharge_2_persisted.png"))

            # ---- 3. PERSIST after partner sync (bridge pull) ----
            row = bridge_get_patient(patient_id)
            assert row is not None, "partner sync did not return the discharged patient"
            assert row["status"] == "discharged", f"partner status != discharged: {row['status']}"
            assert (
                row["discharge_destination"] == DESTINATION
            ), f"partner destination mismatch: {row['discharge_destination']!r}"

            # ---- 4. STILL EDITABLE on the discharged record ----
            panel = open_status_tab(page)
            dest = destination_input(panel)
            expect(dest).to_have_value(DESTINATION, timeout=15000)
            dest.fill(DESTINATION_2)
            update_status(page, panel)

            reload_patient(page, patient_id)
            panel = open_status_tab(page)
            expect(destination_input(panel)).to_have_value(DESTINATION_2, timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "discharge_3_edited.png"))

            # Confirm the edit propagated to the partner too.
            row = bridge_get_patient(patient_id)
            assert row and row["discharge_destination"] == DESTINATION_2, (
                f"partner did not see edited destination: "
                f"{row['discharge_destination'] if row else None!r}"
            )

            browser.close()

        print(
            "PASS: discharge status + destination recorded, persisted through "
            "reload and partner sync, and remained editable"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
