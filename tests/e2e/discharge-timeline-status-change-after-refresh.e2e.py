"""
End-to-end test (UI-driven): changing an ADMITTED patient to "discharged"
through the real Status-tab form and then hard-refreshing shows the correct
admitted-to-discharged status change on the Timeline tab.

The Timeline (TimelineTab in src/routes/_authenticated/patients.$patientId.tsx)
derives status events from the record:
  - "Admitted to critical care"  at admission_date (or created_at)
  - "Discharged"                 at discharge_date (when status == "discharged")
sorted newest-first, so after a discharge the Timeline must contain BOTH the
original admission event AND the new discharge event, with the Discharged event
above the Admitted one and each showing its own British-format date.

Unlike status-changes-timeline-order-timestamps.e2e.py (which drives the
updatePatient RPC directly), this test performs the discharge exactly as a
clinician would: pick "Discharged" in the Status <Select>, choose the discharge
date in the British DatePicker, type a destination, and click "Update status".

Steps:
  1. Seed an ADMITTED patient with admission_date = D1 (5 days ago).
  2. Sign in as a throwaway clinician, open the patient.
  3. Via the Status tab, set status = Discharged, discharge date = today (D2),
     type a destination, save.
  4. Confirm the DB stored status=discharged + both dates.
  5. Hard-refresh, open the Timeline tab, and assert:
       - a "Discharged" event and an "Admitted to critical care" event exist,
       - Discharged appears ABOVE Admitted (newest first),
       - the Discharged row shows D2's British date,
       - the Admitted row shows D1's British date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharge-timeline-status-change-after-refresh.e2e.py
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

MARKER = f"E2ETLUI{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.L.UI"
DESTINATION = f"Ward {MARKER}"

NOW = datetime.now(timezone.utc)
D1 = (NOW.date() - timedelta(days=5)).isoformat()  # admission (older)
D2 = NOW.date().isoformat()                          # discharge (today)


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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "21",
            "status": "admitted",
            "admission_date": D1,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,admission_date,discharge_date,discharge_destination",
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


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def pick_today(page):
    """Open the discharge-date DatePicker popover and select today's date."""
    page.get_by_role("button", name="DD/MM/YYYY").click()
    data_day = f"{NOW.month}/{NOW.day}/{NOW.year}"
    cell = page.locator(f"button[data-day='{data_day}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


def uk(iso_date):
    return datetime.fromisoformat(iso_date).strftime("%d/%m/%Y")


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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            # ---- 1. Discharge via the Status tab UI ----
            panel = open_status_tab(page)
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()
            expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
            pick_today(page)
            panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DESTINATION)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            # ---- 2. Confirm persisted ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status: {row['status']!r}"
            assert row["admission_date"] == D1, f"admission_date: {row['admission_date']!r}"
            assert row["discharge_date"] == D2, f"discharge_date: {row['discharge_date']!r}"

            # ---- 3. Refresh and inspect the Timeline ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"

            tab = page.get_by_role("tab", name="Timeline")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            panel = page.get_by_role("tabpanel")

            discharged_row = panel.get_by_text("Discharged", exact=False).first
            admitted_row = panel.get_by_text("Admitted to critical care", exact=False).first
            expect(discharged_row).to_be_visible(timeout=10000)
            expect(admitted_row).to_be_visible(timeout=10000)

            titles = panel.locator("ol li").all_inner_texts()
            joined = "\n---\n".join(titles)
            disch_idx = next(
                (i for i, t in enumerate(titles) if "Discharged" in t), None
            )
            adm_idx = next(
                (i for i, t in enumerate(titles) if "Admitted to critical care" in t),
                None,
            )
            assert disch_idx is not None, f"no Discharged item:\n{joined}"
            assert adm_idx is not None, f"no Admitted item:\n{joined}"
            assert disch_idx < adm_idx, (
                f"timeline order wrong: Discharged(idx {disch_idx}) should be above "
                f"Admitted(idx {adm_idx}):\n{joined}"
            )

            # Each status event shows its own British-format date.
            assert uk(D2) in titles[disch_idx], (
                f"Discharged row missing date {uk(D2)}: {titles[disch_idx]!r}"
            )
            assert uk(D1) in titles[adm_idx], (
                f"Admitted row missing date {uk(D1)}: {titles[adm_idx]!r}"
            )
            assert uk(D1) != uk(D2), "test dates must differ"

            page.screenshot(path=str(SCREENSHOTS / "discharge_timeline_after_refresh.png"))
            browser.close()

        print(
            "PASS: discharging via the UI produced the admitted-to-discharged status "
            "change on the Timeline (correct order + dates), persisting after refresh"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
