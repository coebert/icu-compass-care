"""
End-to-end test: editing a patient and clearing REQUIRED fields surfaces
validation and does NOT persist any change.

The patient edit form marks Initials (full_name) and Age as required, and the
Weight (kg) field is constrained to 0–600. This test walks the real UI:

  1. Seed a clinician + an admitted patient with known values.
  2. Sign in, open /patients/<id>, open the Edit dialog.
  3. Clear the required "Initials" field and click Save changes.
       -> The dialog stays open (submission blocked) and the field reports a
          native validation message; nothing is written.
  4. Restore Initials, clear the required "Age" field and click Save changes.
       -> Same: blocked, validation message, no write.
  5. Enter an out-of-range Weight (9999, max is 600) and click Save changes.
       -> Blocked by the field constraint; no write.
  6. Hard-refresh and read the record back via the admin REST API to prove the
     patient data is UNCHANGED (initials, age and weight all as seeded).

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-edit-required-fields-validation-blocks-save.e2e.py
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

MARKER = f"E2E-VALIDATION-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "V.A.L."
PATIENT_AGE = 57
PATIENT_WEIGHT = 82


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
            "age": PATIENT_AGE,
            "weight_kg": PATIENT_WEIGHT,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=full_name,age,weight_kg",
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


def clear(el):
    el.click()
    el.press("Control+A")
    el.press("Delete")


def is_invalid(el):
    """Native constraint-validation state for an <input>."""
    return el.evaluate(
        "(node) => ({ valid: node.checkValidity(), message: node.validationMessage })"
    )


def open_edit_dialog(page):
    page.get_by_role("button", name="Edit").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_text("Edit patient")).to_be_visible(timeout=10000)
    return dialog


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

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            dialog = open_edit_dialog(page)

            name_input = dialog.get_by_placeholder("e.g. J.S.")
            age_input = dialog.get_by_role("spinbutton").first  # first number field = Age
            weight_input = dialog.get_by_placeholder("e.g. 78")

            expect(name_input).to_have_value(PATIENT_NAME, timeout=10000)
            expect(age_input).to_have_value(str(PATIENT_AGE))

            # ---- 3. Clear required Initials -> Save must be blocked ----
            clear(name_input)
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(1, timeout=5000)  # still open
            state = is_invalid(name_input)
            assert not state["valid"] and state["message"], (
                f"cleared Initials did not report validation: {state!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "validation_1_missing_initials.png"))

            # restore initials so the next check isolates Age
            name_input.fill(PATIENT_NAME)

            # ---- 4. Clear required Age -> Save must be blocked ----
            clear(age_input)
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(1, timeout=5000)
            state = is_invalid(age_input)
            assert not state["valid"] and state["message"], (
                f"cleared Age did not report validation: {state!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "validation_2_missing_age.png"))

            age_input.fill(str(PATIENT_AGE))

            # ---- 5. Out-of-range Weight -> Save must be blocked ----
            clear(weight_input)
            weight_input.type("9999")
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(1, timeout=5000)
            state = is_invalid(weight_input)
            assert not state["valid"] and state["message"], (
                f"out-of-range Weight did not report validation: {state!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "validation_3_bad_weight.png"))

            # ---- 6. Hard refresh and prove NOTHING was written ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            row = read_patient(patient_id)
            assert row["full_name"] == PATIENT_NAME, f"initials changed: {row!r}"
            assert int(row["age"]) == PATIENT_AGE, f"age changed: {row!r}"
            assert row["weight_kg"] in (PATIENT_WEIGHT, float(PATIENT_WEIGHT)), (
                f"weight changed: {row!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "validation_4_unchanged.png"))

            browser.close()

        print("PASS: missing/invalid required fields blocked save; patient data unchanged")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
