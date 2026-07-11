"""
End-to-end test: changing a patient's status to "Discharged" with a discharge
date and destination via the real Status tab UI, then hard-refreshing and
confirming BOTH the record and the Timeline reflect the correct discharge
information.

The Status tab lives in src/routes/_authenticated/patients.$patientId.tsx
(StatusTab): a status <Select>, a British DatePicker for the discharge date, a
free-text discharge destination <Input>, and an "Update status" button. On
discharge the Timeline surfaces a "Discharged" event (title + destination
detail) dated by discharge_date, plus a "Status changed to Discharged" audit
event.

Steps:
  1. Seed an ADMITTED patient with admission_date = D1 (5 days ago).
  2. Sign in as a throwaway clinician; open the record; Status tab.
  3. Set status = Discharged, pick today's discharge date (D2), type a
     destination; click "Update status".
  4. Confirm the database stored status=discharged, discharge_date=D2 and the
     discharge_destination text.
  5. Hard-refresh; confirm the record header shows the Discharged badge.
  6. Timeline tab: assert a "Discharged" event with the destination detail and
     D2 date, an "Admitted to critical care" event with D1, and a "Status
     changed to Discharged" event — proving the Timeline reflects the discharge.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharge-status-record-timeline-after-refresh.e2e.py
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

MARKER = f"E2EDISCH{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.C.Home"  # <= 10 chars
DESTINATION = f"Salisbury Ward Radnor — step-down {MARKER}"


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


def create_patient(admission_date):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "4",
            "status": "admitted",
            "weight_kg": 82,
            "admission_date": admission_date,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination,admission_date",
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


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def main():
    user_id = patient_id = None
    try:
        now = datetime.now(timezone.utc)
        d1 = (now - timedelta(days=5)).date()
        d2 = now.date()
        uk = lambda d: d.strftime("%d/%m/%Y")
        data_day = f"{now.month}/{now.day}/{now.year}"

        user_id, email = create_user()
        patient_id = create_patient(d1.isoformat())
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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- 1. Set status = Discharged with date + destination ----
            panel = open_tab(page, "Status")
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()

            date_btn = panel.locator(
                "xpath=.//label[normalize-space()='Discharge date']/following::button[1]"
            )
            selected = False
            for _ in range(4):
                date_btn.click()
                cell = page.locator(f"button[data-day='{data_day}']").first
                expect(cell).to_be_visible(timeout=5000)
                cell.click(force=True)
                page.wait_for_timeout(400)
                if "DD/MM/YYYY" not in (date_btn.inner_text() or ""):
                    selected = True
                    break
            assert selected, "discharge date did not register in the picker"

            panel.locator(
                "xpath=.//label[normalize-space()='Discharge destination']/following::input[1]"
            ).fill(DESTINATION)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated", exact=False).first).to_be_visible(timeout=10000)

            # ---- 2. Database persistence ----
            # Allow the mutation + audit write to settle.
            row = None
            for _ in range(10):
                row = read_patient(patient_id)
                if row["status"] == "discharged":
                    break
                time.sleep(0.5)
            assert row["status"] == "discharged", f"status not stored: {row!r}"
            assert (row["discharge_date"] or "").startswith(d2.isoformat()), (
                f"discharge_date: {row['discharge_date']!r}"
            )
            assert row["discharge_destination"] == DESTINATION, (
                f"discharge_destination: {row['discharge_destination']!r}"
            )
            assert (row["admission_date"] or "").startswith(d1.isoformat()), (
                f"admission_date changed: {row['admission_date']!r}"
            )

            # ---- 3. Refresh; record header shows Discharged ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            expect(page.get_by_text("Discharged", exact=False).first).to_be_visible(timeout=15000)

            # ---- 4. Timeline reflects the discharge ----
            panel = open_tab(page, "Timeline")
            discharge_row = panel.locator("li", has_text="Discharged").first
            expect(discharge_row).to_be_visible(timeout=10000)
            expect(discharge_row.get_by_text(DESTINATION, exact=False)).to_be_visible()
            expect(discharge_row.get_by_text(uk(d2), exact=False)).to_be_visible()

            admit_row = panel.locator("li", has_text="Admitted to critical care").first
            expect(admit_row).to_be_visible()
            expect(admit_row.get_by_text(uk(d1), exact=False)).to_be_visible()

            expect(
                panel.get_by_text("Status changed to Discharged", exact=False).first
            ).to_be_visible()
            assert uk(d1) != uk(d2), "admission and discharge dates unexpectedly equal"

            page.screenshot(path=str(SCREENSHOTS / "discharge_record_timeline.png"))
            browser.close()

        print(
            "PASS: status set to Discharged with destination persisted; record and "
            "Timeline both reflect the correct discharge information after refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
