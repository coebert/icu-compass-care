"""
End-to-end test: a patient's clinical data survives editing and discharge.

Walks the real ICU handover UI as an authenticated clinician and exercises the
full "admit -> edit -> discharge -> still-there" journey on one patient:

  1. CREATE   — an admitted patient is created (admin REST API).
  2. EDIT     — through the Edit patient dialog, set the escalation plan (enable
                TEP + TEP details) and the next-of-kin name, then save. Confirm
                the edits persisted to the database.
  3. DISCHARGE — on the Status tab, set the status to "Discharged" with a
                discharge destination and update.
  4. VERIFY (post-discharge)   — the discharged record still shows the patient,
                the discharge destination, the escalation (TEP) details and the
                next-of-kin name.
  5. VERIFY (after refresh)     — hard-reload the record; the same discharged
                data still renders (nothing is lost on reload).
  6. VERIFY (database)          — an independent admin read confirms status,
                destination, TEP details and NOK name are all persisted.

The throwaway user + patient are created and removed via the Supabase admin
REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-edit-discharge-persists.e2e.py
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
MARKER = f"EDIT{STAMP}"
PATIENT_NAME = "E.D."
PASSWORD = "Test-Passw0rd-123!"

TEP_DETAILS = f"Ceiling of care ward-based {MARKER}"
NOK_NAME = f"Relative {MARKER}"
DESTINATION = f"{MARKER}-WARD-8"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-{MARKER.lower()}@example.com"
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
            "age": 62,
            "weight_kg": 78,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "6",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_destination,tep_in_place,tep_details,nok_name",
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


def reload_patient(page, patient_id):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"
    expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)


def wait_for_db(patient_id, predicate, timeout=15):
    deadline = time.time() + timeout
    row = None
    while time.time() < deadline:
        row = read_patient(patient_id)
        if predicate(row):
            return row
        time.sleep(0.5)
    return row


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

            # ---- 1. Detail page loads ----
            reload_patient(page, patient_id)
            expect(page.get_by_role("tab", name="Overview")).to_be_visible(timeout=15000)

            # ---- 2. Edit escalation plan + next of kin via the Edit dialog ----
            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)

            # Enable the TEP switch (escalation plan) if not already on.
            tep_row = dialog.get_by_text(
                "Treatment escalation plan (TEP) in place", exact=True
            ).locator("xpath=ancestor::div[contains(@class,'border')][1]")
            tep_switch = tep_row.get_by_role("switch")
            if tep_switch.get_attribute("aria-checked") != "true":
                tep_switch.click()

            # TEP details textarea appears once TEP is enabled.
            tep_details = dialog.get_by_text("TEP details", exact=True).locator(
                "xpath=following-sibling::textarea"
            )
            expect(tep_details).to_be_visible(timeout=10000)
            tep_details.click()
            tep_details.fill(TEP_DETAILS)

            # Next-of-kin name (first input under the "Next of kin" section).
            nok_name = dialog.get_by_text("Name", exact=True).locator(
                "xpath=following-sibling::input"
            )
            nok_name.click()
            nok_name.fill(NOK_NAME)

            page.screenshot(path=str(SCREENSHOTS / "edit_discharge_1_editing.png"))
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            edited = wait_for_db(
                patient_id,
                lambda r: r["tep_details"] == TEP_DETAILS and r["nok_name"] == NOK_NAME,
            )
            assert edited["tep_in_place"] is True, "TEP was not enabled"
            assert edited["tep_details"] == TEP_DETAILS, f"TEP details not saved: {edited['tep_details']!r}"
            assert edited["nok_name"] == NOK_NAME, f"NOK name not saved: {edited['nok_name']!r}"

            # ---- 3. Discharge the patient on the Status tab ----
            page.get_by_role("tab", name="Status").click()
            panel = page.get_by_role("tabpanel")
            expect(panel.get_by_text("Patient status", exact=True)).to_be_visible(timeout=15000)
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()
            dest_input = panel.get_by_text("Discharge destination", exact=True).locator(
                "xpath=following-sibling::input"
            )
            expect(dest_input).to_be_visible(timeout=10000)
            dest_input.fill(DESTINATION)

            # A discharge date is required to mark a patient as discharged.
            panel.get_by_role("button", name="DD/MM/YYYY").click()
            today_label = time.strftime("%A, %-d %B %Y")  # e.g. "Saturday, 11 July 2026"
            page.get_by_role("button", name=today_label).click()
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated", exact=False).first).to_be_visible(timeout=15000)

            discharged = wait_for_db(patient_id, lambda r: r["status"] == "discharged")
            assert discharged["status"] == "discharged", f"status not discharged: {discharged['status']!r}"
            assert discharged["discharge_destination"] == DESTINATION, (
                f"destination not saved: {discharged['discharge_destination']!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "edit_discharge_2_discharged.png"))

            # ---- 4 & 5. After a hard refresh, discharged data still renders ----
            reload_patient(page, patient_id)
            dom_text = page.evaluate("() => document.body.innerText")
            assert TEP_DETAILS in dom_text, "escalation (TEP) details missing after discharge + refresh"
            assert NOK_NAME in dom_text, "next-of-kin name missing after discharge + refresh"
            assert DESTINATION in dom_text, "discharge destination missing after discharge + refresh"
            # Status tab still reflects the discharge.
            page.get_by_role("tab", name="Status").click()
            panel = page.get_by_role("tabpanel")
            expect(panel.get_by_text("Discharge destination", exact=True)).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "edit_discharge_3_after_refresh.png"))

            # ---- 6. Database reflects the final state ----
            final = read_patient(patient_id)
            assert final["status"] == "discharged"
            assert final["discharge_destination"] == DESTINATION
            assert final["tep_details"] == TEP_DETAILS
            assert final["nok_name"] == NOK_NAME

            browser.close()

        print(
            "PASS: patient edits (escalation + NOK) and discharge persist and "
            "render correctly after discharge and refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
