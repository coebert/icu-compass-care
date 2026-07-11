"""
End-to-end test: updating the treatment escalation plan (TEP) and the
DNACPR (DNR / do-not-attempt-CPR) decision through the real Edit-patient form
persists those details in BOTH the database and the UI after a full refresh.

The escalation controls live in src/components/PatientForm.tsx:
  - "Treatment escalation plan (TEP) in place"  -> tep_in_place + tep_details
  - "DNACPR — decision not to attempt CPR"      -> dnacpr_decision + dnacpr_date
                                                   + dnacpr_details
They are read back on the patient detail page under the "Escalation & Resus"
tab (src/routes/_authenticated/patients.$patientId.tsx).

Steps:
  1. Seed an admitted patient with NO TEP and NO DNACPR decision.
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Switch ON TEP, enter TEP details; switch ON DNACPR, pick today's DNACPR
     date, enter DNACPR details; Save.
  4. Read the database — assert tep_in_place, tep_details, dnacpr_decision,
     dnacpr_date and dnacpr_details all stored.
  5. Hard-refresh, open the "Escalation & Resus" tab, and assert the UI shows
     "TEP in place", the TEP details, "DNACPR decision made", the British-format
     DNACPR date, and the DNACPR details.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/escalation-dnacpr-edit-persists-refresh.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone
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

MARKER = f"E2EESC{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.R. Esc"  # <= 10 chars
TEP_DETAILS = f"Ceiling of care: ward-based, no ICU re-admission {MARKER}"
DNACPR_DETAILS = f"DNACPR agreed with family {MARKER}"


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
            "age": 79,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "12",
            "status": "admitted",
            "tep_in_place": False,
            "dnacpr_decision": False,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details,dnacpr_decision,dnacpr_details,dnacpr_date",
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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        now = datetime.now(timezone.utc)
        today_iso = now.date().isoformat()
        data_day = f"{now.month}/{now.day}/{now.year}"  # DatePicker cell key
        expected_uk_date = now.strftime("%d/%m/%Y")       # fmtDate en-GB

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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 1. Update escalation + DNACPR via the Edit form ----
            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(
                timeout=10000
            )

            switches = dialog.get_by_role("switch")
            # Order in PatientForm.tsx: [0]=isolation, [1]=TEP, [2]=DNACPR.
            tep_switch = switches.nth(1)
            tep_switch.scroll_into_view_if_needed()
            tep_switch.click()
            expect(tep_switch).to_have_attribute("data-state", "checked", timeout=5000)
            dialog.locator(
                "xpath=.//label[normalize-space()='TEP details']/following-sibling::textarea[1]"
            ).fill(TEP_DETAILS)

            dnacpr_switch = switches.nth(2)
            dnacpr_switch.scroll_into_view_if_needed()
            dnacpr_switch.click()
            expect(dnacpr_switch).to_have_attribute(
                "data-state", "checked", timeout=5000
            )
            # DNACPR date via the British DatePicker popover.
            dialog.get_by_role("button", name="DD/MM/YYYY").first.click()
            cell = page.locator(f"button[data-day='{data_day}']").first
            expect(cell).to_be_visible(timeout=5000)
            cell.click()
            dialog.locator(
                "xpath=.//label[normalize-space()='DNACPR details']/following-sibling::input[1]"
            ).fill(DNACPR_DETAILS)

            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("heading", name="Edit patient")).to_have_count(
                0, timeout=10000
            )

            # ---- 2. Database persistence ----
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place not stored"
            assert row["tep_details"] == TEP_DETAILS, (
                f"tep_details not stored: {row['tep_details']!r}"
            )
            assert row["dnacpr_decision"] is True, "dnacpr_decision not stored"
            assert row["dnacpr_details"] == DNACPR_DETAILS, (
                f"dnacpr_details not stored: {row['dnacpr_details']!r}"
            )
            assert (row["dnacpr_date"] or "").startswith(today_iso), (
                f"dnacpr_date not stored: {row['dnacpr_date']!r}"
            )

            # ---- 3. Refresh and verify the UI reflects the saved values ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"

            tab = page.get_by_role("tab", name="Escalation & Resus")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            panel = page.get_by_role("tabpanel")

            expect(panel.get_by_text("TEP in place", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(TEP_DETAILS, exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(
                panel.get_by_text("DNACPR decision made", exact=False).first
            ).to_be_visible(timeout=10000)
            expect(panel.get_by_text(expected_uk_date, exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(DNACPR_DETAILS, exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(
                path=str(SCREENSHOTS / "escalation_dnacpr_after_refresh.png")
            )
            browser.close()

        print(
            "PASS: TEP + DNACPR updates persisted in the database and remained "
            "visible on the Escalation & Resus tab after a full refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
