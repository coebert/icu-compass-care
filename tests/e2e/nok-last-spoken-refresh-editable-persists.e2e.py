"""
End-to-end test: next-of-kin (NOK) details and the "last updated / spoken to"
date survive a full page REFRESH and remain editable when Edit is re-opened.

Drives the real ICU handover app as an authenticated admin against one patient:

  1. UPDATE   — open Edit, fill the Next of kin block (name, relationship,
                contact, "Last updated / spoken to" date+time, updated-by) and
                Save. Confirm the NOK tab shows them.
  2. REFRESH  — hard-reload the detail page (new document, fresh hydration) and
                confirm every NOK field + the spoken-to date/time still render.
  3. RE-OPEN EDIT — reopen the Edit form and confirm each NOK input is
                pre-populated (still editable), proving nothing was lost across
                the reload.
  4. PERSIST  — amend the contact + updated-by, Save, refresh AGAIN, and confirm
                the amended values persist (and the old contact is gone), both
                in the UI and in the database row.

The patient row and throwaway admin user are created and removed via the
Supabase admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/nok-last-spoken-refresh-editable-persists.e2e.py
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

MARKER = f"NOKR{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

NOK_NAME = f"{MARKER}-KIN"
NOK_REL = f"{MARKER}-SON"
NOK_CONTACT = f"{MARKER}-07700900111"
NOK_UPDATED_BY = f"{MARKER}-NURSE"
NOK_CONTACT_2 = f"{MARKER}-07700900222"
NOK_UPDATED_BY_2 = f"{MARKER}-DR"
SPOKEN_DAY = 15  # mid-month day, unique in the calendar grid
SPOKEN_TIME = "14:30"


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
            "full_name": "E2E NOK",
            "age": 61,
            "location_type": "icu",
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


def read_nok(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=nok_name,nok_relationship,nok_contact,nok_last_updated,nok_last_updated_by",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


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


# ---- form helpers (scoped to the open Edit dialog) --------------------------

def text_input(scope, label):
    return scope.get_by_text(label, exact=True).locator("xpath=following-sibling::input")


def open_edit(page):
    page.get_by_role("button", name="Edit").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=15000)
    dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()
    return dialog


def save(page, dialog):
    dialog.get_by_role("button", name="Save changes").click()
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)


def fill_spoken_to(dialog):
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(SPOKEN_DAY), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(SPOKEN_TIME)


def show_nok_tab(page):
    page.get_by_role("tab", name="Next of kin").click()


def refresh_to_nok(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"redirected to /auth after refresh: {page.url}"
    show_nok_tab(page)


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

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"

            # ---- 1. UPDATE NOK details + last spoken date ----
            dialog = open_edit(page)
            text_input(dialog, "Name").fill(NOK_NAME)
            text_input(dialog, "Relationship").fill(NOK_REL)
            text_input(dialog, "Contact details").fill(NOK_CONTACT)
            fill_spoken_to(dialog)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY)
            save(page, dialog)

            show_nok_tab(page)
            for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "nokr_1_updated.png"))

            # ---- 2. REFRESH — details survive a fresh page load ----
            refresh_to_nok(page)
            for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            expect(page.get_by_text(f"{SPOKEN_DAY:02d}/", exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_text(SPOKEN_TIME, exact=False).first).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "nokr_2_after_refresh.png"))

            # ---- 3. RE-OPEN EDIT — inputs pre-populated + still editable ----
            dialog = open_edit(page)
            expect(text_input(dialog, "Name")).to_have_value(NOK_NAME, timeout=15000)
            expect(text_input(dialog, "Relationship")).to_have_value(NOK_REL)
            expect(text_input(dialog, "Contact details")).to_have_value(NOK_CONTACT)
            expect(text_input(dialog, "Updated by (staff name)")).to_have_value(NOK_UPDATED_BY)
            # The spoken-to time input round-trips too.
            spoken = dialog.get_by_text("Last updated / spoken to", exact=True)
            expect(
                spoken.locator("xpath=following-sibling::div//input[@type='time']")
            ).to_have_value(SPOKEN_TIME)

            # ---- 4. Amend + Save + refresh again — amendments persist ----
            text_input(dialog, "Contact details").fill(NOK_CONTACT_2)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY_2)
            save(page, dialog)

            refresh_to_nok(page)
            expect(page.get_by_text(NOK_CONTACT_2, exact=True)).to_be_visible(timeout=15000)
            expect(page.get_by_text(NOK_UPDATED_BY_2, exact=True)).to_be_visible(timeout=15000)
            assert page.get_by_text(NOK_CONTACT, exact=True).count() == 0, (
                "old contact still shown after amendment + refresh"
            )
            page.screenshot(path=str(SCREENSHOTS / "nokr_3_amended_after_refresh.png"))

            browser.close()

        # Database is the source of truth for persistence.
        row = read_nok(patient_id)
        assert row, "patient row missing after test"
        assert row["nok_name"] == NOK_NAME, f"nok_name not persisted: {row['nok_name']!r}"
        assert row["nok_relationship"] == NOK_REL, "nok_relationship not persisted"
        assert row["nok_contact"] == NOK_CONTACT_2, (
            f"amended nok_contact not persisted: {row['nok_contact']!r}"
        )
        assert row["nok_last_updated_by"] == NOK_UPDATED_BY_2, (
            f"amended nok_last_updated_by not persisted: {row['nok_last_updated_by']!r}"
        )
        assert row["nok_last_updated"], "nok_last_updated (last spoken date) not persisted"

        print(
            "PASS: NOK details + last spoken date persisted across refresh, "
            "remained editable on re-open, and amendments persisted"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
