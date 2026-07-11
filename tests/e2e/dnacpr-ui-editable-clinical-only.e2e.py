"""
End-to-end test (UI, both roles): a NON-clinical user cannot edit a patient's
DNACPR / not-for-CPR fields through the UI, while a CLINICAL user can — and the
stored values only ever change as a result of the clinical user's edit.

DNACPR is stored on `patients` as:
  - dnacpr_decision (boolean)
  - dnacpr_details  (text)

The patient detail route (src/routes/_authenticated/patients.$patientId.tsx)
gates the whole record behind clinical access. A non-clinical user sees
<ClinicalAccessRequired> ("Clinical access required") and never gets an Edit
button or the Escalation & resuscitation fields. A clinical user gets the Edit
modal, toggles DNACPR on and enters details, saves, and the value persists.

Steps:
  1. Seed a patient with NO DNACPR (admin API).
  2. NON-clinical user opens the record: assert the access-required message,
     no Edit button, and (admin read) DNACPR is still unset — nothing changed.
  3. CLINICAL user opens the record, Edit -> toggle DNACPR on + enter details
     -> Save. Assert (admin read) dnacpr_decision=true and dnacpr_details match.

All fixtures are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/dnacpr-ui-editable-clinical-only.e2e.py
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
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"D.U.I.{SUFFIX}"
DNACPR_DETAILS = f"Ward-based ceiling of care, not for CPR — {SUFFIX}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user(role):
    # role=None => non-clinical (no user_roles row).
    email = f"e2e-dnacpr-ui-{role or 'none'}-{STAMP}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    if role:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/user_roles",
            headers=admin_headers(),
            json={"user_id": uid, "role": role},
            timeout=30,
        ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "5",
            "status": "admitted",
            # Deliberately NO DNACPR — set via the UI by the clinical user.
            "dnacpr_decision": False,
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


def read_dnacpr(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=dnacpr_decision,dnacpr_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def restore_session(page, session):
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [STORAGE_KEY, json.dumps(session)],
    )


def cleanup(patient_id, user_ids):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    for uid in user_ids:
        if uid:
            requests.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
                headers=admin_headers(),
                timeout=30,
            )


def main():
    patient_id = None
    nonclin_id = clin_id = None
    try:
        nonclin_id, nonclin_email = create_user(None)
        clin_id, clin_email = create_user("clinician")
        patient_id = create_patient()

        nonclin_session = sign_in(nonclin_email)
        clin_session = sign_in(clin_email)

        # Baseline: no DNACPR set.
        base = read_dnacpr(patient_id)
        assert base["dnacpr_decision"] in (False, None), f"baseline dnacpr set? {base}"

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            # ---- (1) NON-clinical user: cannot edit DNACPR ----
            ctx1 = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = ctx1.new_page()
            restore_session(page, nonclin_session)
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            assert "/auth" not in page.url, f"non-clinical redirected to /auth: {page.url}"

            expect(
                page.get_by_text("Clinical access required", exact=False)
            ).to_be_visible(timeout=15000)
            assert page.get_by_role("button", name="Edit").count() == 0, (
                "non-clinical user must not see an Edit button"
            )
            page.screenshot(path=str(SCREENSHOTS / f"dnacpr_nonclin_gated_{SUFFIX}.png"))
            ctx1.close()

            # Confirm the non-clinical visit changed nothing.
            after_nonclin = read_dnacpr(patient_id)
            assert after_nonclin == base, (
                f"DNACPR changed after non-clinical visit: {after_nonclin} != {base}"
            )

            # ---- (2) CLINICAL user: can edit DNACPR via the UI ----
            ctx2 = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = ctx2.new_page()
            restore_session(page, clin_session)
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            assert "/auth" not in page.url, f"clinical redirected to /auth: {page.url}"
            expect(
                page.get_by_text(PATIENT_NAME, exact=False).first
            ).to_be_visible(timeout=15000)

            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=10000)

            # Escalation & resuscitation: switch 0 = TEP, switch 1 = DNACPR.
            switches = dialog.get_by_role("switch")
            expect(switches.first).to_be_visible(timeout=10000)
            dnacpr_switch = switches.nth(1)
            if dnacpr_switch.get_attribute("aria-checked") != "true":
                dnacpr_switch.click()

            dnacpr_details = dialog.locator(
                "div.space-y-1\\.5:has(> label:text-is('DNACPR details')) input"
            )
            expect(dnacpr_details).to_be_visible(timeout=10000)
            dnacpr_details.fill(DNACPR_DETAILS)

            dialog.get_by_role("button", name="Save changes").click()
            expect(dialog).to_be_hidden(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / f"dnacpr_clin_saved_{SUFFIX}.png"))
            ctx2.close()

            browser.close()

        # ---- (3) Verify only the clinical edit persisted ----
        final = read_dnacpr(patient_id)
        assert final["dnacpr_decision"] is True, (
            f"clinical DNACPR edit did not persist: {final}"
        )
        assert final["dnacpr_details"] == DNACPR_DETAILS, (
            f"clinical DNACPR details did not persist: {final}"
        )

        print(
            "PASS: non-clinical user cannot edit DNACPR (gated, values unchanged) "
            "while the clinical user's UI edit persists"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, [nonclin_id, clin_id])


if __name__ == "__main__":
    sys.exit(main())
