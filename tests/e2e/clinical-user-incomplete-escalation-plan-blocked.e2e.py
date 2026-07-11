"""
End-to-end UI test (form validation): a signed-in CLINICAL user opens a
patient's edit form, switches the Treatment Escalation Plan (TEP) on but leaves
the escalation-plan details blank (an "incomplete escalation plan"), and the
form's validation must PREVENT the invalid data from being persisted.

What this proves against the live app (http://localhost:8080):

  1. With TEP switched on and details empty, the form shows a validation error
     and the "Save changes" button is disabled — the incomplete plan cannot be
     submitted.
  2. Nothing was persisted: re-reading the patient via the service role shows
     tep_in_place still false and tep_details still empty.
  3. Positive control: filling in the details clears the error, enables save,
     and the now-complete escalation plan DOES persist.

A throwaway clinician user and a patient are created / cleaned up via the
Supabase admin REST API; the browser signs in through the real /auth form.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Playwright + Chromium are preinstalled in the sandbox.

Run:  python3 tests/e2e/clinical-user-incomplete-escalation-plan-blocked.e2e.py
Exits 0 on success, non-zero on failure.
"""

import asyncio
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from playwright.async_api import async_playwright

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]
BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8080").rstrip("/")

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"
EMAIL = f"e2e-tepform-{STAMP}@example.com"
PATIENT_NAME = f"T.F.{SUFFIX}"
TEP_DETAILS = f"Ward-level ceiling of care — {SUFFIX}"

SCREENSHOTS = Path("/tmp/browser/tep-form")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_clinical_user():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": EMAIL, "password": PASSWORD, "email_confirm": True},
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
    return uid


def create_patient():
    admission = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 69,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": admission,
            "tep_in_place": False,
            "tep_details": None,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=id,tep_in_place,tep_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


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


async def run(patient_id):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()

        # ---- Sign in through the real /auth form ----
        await page.goto(f"{BASE_URL}/auth", wait_until="domcontentloaded")
        await page.fill("#email", EMAIL)
        await page.fill("#password", PASSWORD)
        await page.get_by_role("button", name="Sign in").click()
        await page.wait_for_url("**/patients", timeout=30000)

        # ---- Open the patient's edit form ----
        await page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
        await page.get_by_role("button", name="Edit", exact=True).first.click()
        dialog = page.get_by_role("dialog")
        await dialog.get_by_text("Edit patient").wait_for(timeout=15000)

        # ---- Switch TEP on, leave details blank (incomplete escalation plan) ----
        tep_row = dialog.locator("div.rounded-lg.border").filter(
            has_text="Treatment escalation plan (TEP) in place"
        )
        await tep_row.get_by_role("switch").click()
        await dialog.get_by_text("TEP details", exact=True).wait_for(timeout=10000)
        await page.screenshot(path=str(SCREENSHOTS / "1_incomplete.png"))

        # Validation must block: error visible AND save disabled.
        alert = dialog.get_by_role("alert")
        assert await alert.count() > 0, "expected a validation error for blank TEP details"
        alert_text = (await alert.first.inner_text()).strip()
        assert "TEP details are required" in alert_text, (
            f"unexpected validation message: {alert_text!r}"
        )
        save = dialog.get_by_role("button", name="Save changes")
        assert await save.is_disabled(), (
            "Save must be disabled while the escalation plan is incomplete"
        )

        # Attempt to click anyway — it must not persist anything.
        await save.click(force=True)
        await page.wait_for_timeout(800)
        after_block = read_patient(patient_id)
        assert after_block["tep_in_place"] is False, (
            f"incomplete escalation plan was persisted! {after_block}"
        )
        assert not after_block["tep_details"], (
            f"tep_details was persisted despite invalid form: {after_block}"
        )

        # ---- Positive control: completing the plan enables save + persists ----
        tep_field = dialog.locator("div.space-y-1\\.5").filter(has_text="TEP details")
        await tep_field.locator("textarea").fill(TEP_DETAILS)
        await page.wait_for_timeout(200)
        assert await alert.count() == 0, "validation error should clear once details are filled"
        save = dialog.get_by_role("button", name="Save changes")
        assert not await save.is_disabled(), (
            "Save should be enabled once TEP details are provided"
        )
        await save.click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SCREENSHOTS / "2_after_save.png"))


        after_ok = read_patient(patient_id)
        assert after_ok["tep_in_place"] is True, (
            f"completed escalation plan did not persist tep_in_place: {after_ok}"
        )
        assert after_ok["tep_details"], (
            f"completed escalation plan did not persist tep_details: {after_ok}"
        )

        await browser.close()


def main():
    user_id = None
    patient_id = None
    try:
        user_id = create_clinical_user()
        patient_id = create_patient()
        asyncio.run(run(patient_id))
        print(
            "PASS: incomplete escalation plan is blocked by form validation "
            "(not persisted); completing the plan then persists correctly"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
