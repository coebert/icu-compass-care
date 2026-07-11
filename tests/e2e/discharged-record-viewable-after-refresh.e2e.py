"""
End-to-end test (UI-driven): after a clinician marks a patient as DISCHARGED
and the app is refreshed, the patient record must remain fully VIEWABLE — the
"Discharged" status and the discharge destination must be displayed in the
read-only record (status badge + Timeline), not just retained in a form field.

Flow:
  1. Seed an admitted patient + clinician user (admin REST API); sign in.
  2. Open /patients/<id>, go to the Status tab, choose "Discharged", pick a
     discharge date (today) and type a discharge destination, then save.
  3. Confirm the DB stored status=discharged + the destination.
  4. HARD REFRESH the app.
  5. Verify the record is still viewable (no /auth bounce, patient header +
     record tabs present), the header shows the "Discharged" status badge, and
     the Timeline tab DISPLAYS the discharge event with the destination as
     read-only content (asserted against innerText, not an <input> value).

Throwaway user + patient are removed via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharged-record-viewable-after-refresh.e2e.py
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

MARKER = f"E2E-DCVIEW-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.C.V."
DEST = f"Ward 12 stepdown {MARKER}"


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
            "age": 69,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination",
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


def pick_today(page):
    page.get_by_role("button", name="DD/MM/YYYY").click()
    now = datetime.now(timezone.utc)
    data_day = f"{now.month}/{now.day}/{now.year}"
    cell = page.locator(f"button[data-day='{data_day}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)
        today = datetime.now(timezone.utc).date().isoformat()

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

            # ---- 1. Mark discharged via the Status tab UI ----
            panel = open_tab(page, "Status")
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()
            expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
            pick_today(page)
            panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DEST)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            # ---- 2. DB confirms the discharge persisted ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status not stored: {row['status']!r}"
            assert row["discharge_destination"] == DEST, (
                f"destination not stored: {row['discharge_destination']!r}"
            )
            assert row["discharge_date"] == today, (
                f"discharge date not stored: {row['discharge_date']!r} != {today!r}"
            )

            # ---- 3. HARD REFRESH ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"

            # ---- 4. Record still viewable: header + record tabs present ----
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_role("tab", name="Overview")).to_be_visible(timeout=15000)

            # ---- 5a. "Discharged" status is displayed (header badge) ----
            expect(page.get_by_text("Discharged", exact=True).first).to_be_visible(
                timeout=10000
            )

            # ---- 5b. Timeline DISPLAYS the discharge event + destination (read-only) ----
            panel = open_tab(page, "Timeline")
            panel_text = panel.inner_text()
            assert "Discharged" in panel_text, (
                f"Timeline did not display the discharge event: {panel_text[:400]!r}"
            )
            assert DEST in panel_text, (
                f"Timeline did not display the discharge destination: {panel_text[:400]!r}"
            )
            # The destination is rendered as read-only content, not a form input.
            assert panel.locator(f"input[value='{DEST}']").count() == 0, (
                "destination shown as an editable input on the Timeline, expected read-only text"
            )
            page.screenshot(path=str(SCREENSHOTS / "discharged_record_viewable_after_refresh.png"))

            browser.close()

        print(
            "PASS: after discharge + refresh, the record stays viewable with the "
            "Discharged status badge and the discharge destination displayed read-only"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
