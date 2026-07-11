"""
End-to-end test: after saving a treatment escalation plan (TEP) and a DNACPR
(decision not to attempt CPR) for a patient and refreshing the app, those
sections remain EDITABLE and every change persists correctly.

This complements escalation-dnacpr-edit-persists-refresh.e2e.py (which proves a
first save persists and renders). Here the emphasis is editability across a
refresh: the saved values must come back pre-populated in the Edit form so a
clinician can amend them, and the amendments must themselves persist.

The escalation controls live in src/components/PatientForm.tsx:
  - "Treatment escalation plan (TEP) in place"  -> tep_in_place + tep_details
  - "DNACPR — decision not to attempt CPR"      -> dnacpr_decision + dnacpr_date
                                                   + dnacpr_details
Read back on the patient detail page under the "Escalation & Resus" tab
(src/routes/_authenticated/patients.$patientId.tsx).

Steps:
  1. Seed an admitted patient with NO TEP and NO DNACPR decision.
  2. Sign in as a throwaway clinician; open the record and Edit it.
  3. Switch ON TEP + enter details; switch ON DNACPR, pick today's date +
     enter details; Save.
  4. Confirm the database stored all five fields.
  5. Hard-refresh; confirm the Escalation & Resus tab shows the saved values.
  6. EDITABILITY: re-open the Edit form and assert the saved TEP/DNACPR details
     are pre-populated (both switches ON), then AMEND both detail texts and Save.
  7. Confirm the amended values persisted to the database.
  8. Hard-refresh again; confirm the tab shows the amended values and the
     original values are gone — proving the sections stay editable and persist.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/escalation-dnacpr-editable-persists-refresh.e2e.py
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

MARKER = f"E2EESCED{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.R.Edit"  # <= 10 chars
TEP_DETAILS = f"Ceiling of care: ward-based, no ICU re-admission {MARKER}"
DNACPR_DETAILS = f"DNACPR agreed with family {MARKER}"
TEP_DETAILS_2 = f"Ceiling revised: for full escalation on next review {MARKER}"
DNACPR_DETAILS_2 = f"DNACPR reviewed and reaffirmed by consultant {MARKER}"


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
            "weight_kg": 80,
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


def open_edit(page):
    page.get_by_role("button", name="Edit").first.click()
    dialog = page.get_by_role("dialog")
    expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(timeout=10000)
    return dialog


def save_edit(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("heading", name="Edit patient")).to_have_count(
        0, timeout=10000
    )


def open_escalation_tab(page):
    tab = page.get_by_role("tab", name="Escalation & Resus")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def tep_details_field(dialog):
    return dialog.locator(
        "xpath=.//label[normalize-space()='TEP details']/following-sibling::textarea[1]"
    )


def dnacpr_details_field(dialog):
    return dialog.locator(
        "xpath=.//label[normalize-space()='DNACPR details']/following-sibling::input[1]"
    )


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        now = datetime.now(timezone.utc)
        today_iso = now.date().isoformat()
        data_day = f"{now.month}/{now.day}/{now.year}"
        expected_uk_date = now.strftime("%d/%m/%Y")

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

            # ---- 1. First save: switch ON TEP + DNACPR with details/date ----
            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            # Order in PatientForm.tsx: [0]=isolation, [1]=TEP, [2]=DNACPR.
            tep_switch = switches.nth(1)
            tep_switch.scroll_into_view_if_needed()
            tep_switch.click()
            expect(tep_switch).to_have_attribute("data-state", "checked", timeout=5000)
            tep_details_field(dialog).fill(TEP_DETAILS)

            dnacpr_switch = switches.nth(2)
            dnacpr_switch.scroll_into_view_if_needed()
            dnacpr_switch.click()
            expect(dnacpr_switch).to_have_attribute("data-state", "checked", timeout=5000)

            dnacpr_date_btn = dialog.locator(
                "xpath=.//label[normalize-space()='DNACPR date']/following::button[1]"
            )
            selected = False
            for _ in range(4):
                dnacpr_date_btn.click()
                cell = page.locator(f"button[data-day='{data_day}']").first
                expect(cell).to_be_visible(timeout=5000)
                cell.click(force=True)
                page.wait_for_timeout(400)
                if "DD/MM/YYYY" not in (dnacpr_date_btn.inner_text() or ""):
                    selected = True
                    break
            assert selected, "DNACPR date did not register in the picker"
            dnacpr_details_field(dialog).fill(DNACPR_DETAILS)
            save_edit(page, dialog)

            # ---- 2. Database persistence of the first save ----
            row = read_patient(patient_id)
            assert row["tep_in_place"] is True, "tep_in_place not stored"
            assert row["tep_details"] == TEP_DETAILS, f"tep_details: {row['tep_details']!r}"
            assert row["dnacpr_decision"] is True, "dnacpr_decision not stored"
            assert row["dnacpr_details"] == DNACPR_DETAILS, (
                f"dnacpr_details: {row['dnacpr_details']!r}"
            )
            assert (row["dnacpr_date"] or "").startswith(today_iso), (
                f"dnacpr_date: {row['dnacpr_date']!r}"
            )

            # ---- 3. Refresh; tab shows the saved values ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            panel = open_escalation_tab(page)
            expect(panel.get_by_text("TEP in place", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(TEP_DETAILS, exact=False).first).to_be_visible()
            expect(
                panel.get_by_text("DNACPR decision made", exact=False).first
            ).to_be_visible()
            expect(panel.get_by_text(expected_uk_date, exact=False).first).to_be_visible()
            expect(panel.get_by_text(DNACPR_DETAILS, exact=False).first).to_be_visible()

            # ---- 4. EDITABILITY: re-open Edit; fields pre-populated + editable ----
            dialog = open_edit(page)
            switches = dialog.get_by_role("switch")
            expect(switches.nth(1)).to_have_attribute("data-state", "checked", timeout=5000)
            expect(switches.nth(2)).to_have_attribute("data-state", "checked", timeout=5000)
            expect(tep_details_field(dialog)).to_have_value(TEP_DETAILS, timeout=10000)
            expect(dnacpr_details_field(dialog)).to_have_value(DNACPR_DETAILS, timeout=10000)

            # Amend both detail sections.
            tep_details_field(dialog).fill(TEP_DETAILS_2)
            dnacpr_details_field(dialog).fill(DNACPR_DETAILS_2)
            save_edit(page, dialog)

            # ---- 5. Amended values persisted to the database ----
            row2 = read_patient(patient_id)
            assert row2["tep_in_place"] is True, "TEP switched off unexpectedly"
            assert row2["dnacpr_decision"] is True, "DNACPR switched off unexpectedly"
            assert row2["tep_details"] == TEP_DETAILS_2, (
                f"amended tep_details did not persist: {row2['tep_details']!r}"
            )
            assert row2["dnacpr_details"] == DNACPR_DETAILS_2, (
                f"amended dnacpr_details did not persist: {row2['dnacpr_details']!r}"
            )
            assert (row2["dnacpr_date"] or "").startswith(today_iso), (
                f"dnacpr_date lost after edit: {row2['dnacpr_date']!r}"
            )

            # ---- 6. Refresh again; tab shows amended values, old ones gone ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            panel = open_escalation_tab(page)
            expect(panel.get_by_text(TEP_DETAILS_2, exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(DNACPR_DETAILS_2, exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(panel.get_by_text(TEP_DETAILS, exact=True)).to_have_count(0)
            expect(panel.get_by_text(DNACPR_DETAILS, exact=True)).to_have_count(0)
            expect(panel.get_by_text("TEP in place", exact=False).first).to_be_visible()
            expect(
                panel.get_by_text("DNACPR decision made", exact=False).first
            ).to_be_visible()
            page.screenshot(
                path=str(SCREENSHOTS / "escalation_dnacpr_editable_after_refresh.png")
            )
            browser.close()

        print(
            "PASS: TEP + DNACPR saved, persisted, remained editable after refresh, "
            "and the amended values persisted correctly across a second refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
