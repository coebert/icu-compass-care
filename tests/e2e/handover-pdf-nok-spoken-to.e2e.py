"""
End-to-end test: next-of-kin details AND the "Last updated / spoken to"
timestamp entered through the real UI are rendered in the exported handover PDF.

The handover sheet's flags column renders a NOK line via flags() in
src/lib/handover-pdf.ts:

  NOK: <name> (<relationship>) <contact> [Spoken to <dd/mm/yyyy, HH:MM> by <staff>]

where the timestamp is fmtDateTime(nok_last_updated) — en-GB "dd/mm/yyyy, HH:MM"
in 24h form. The render timezone is pinned so the expected stamp is
deterministic.

Steps:
  1. Seed one throwaway patient (no NOK details yet).
  2. Sign in as a clinician/admin, open the patient, and through the real Edit
     dialog fill the Next of kin block: name, relationship, contact, the
     "Last updated / spoken to" date+time, and "Updated by (staff name)".
  3. Confirm the NOK tab shows the saved details.
  4. Export + download the handover PDF from the real UI.
  5. Assert the PDF's NOK line shows the name, relationship, contact, the
     spoken-to timestamp (dd/mm/yyyy, HH:MM) and the updating staff name.

Throwaway admin user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-nok-spoken-to.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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

MARKER = f"NOKPDF{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.O.K.PDF"

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

NOK_NAME = f"{MARKER}-KIN"
NOK_REL = f"{MARKER}-SON"
NOK_CONTACT = f"{MARKER}-07700900123"
NOK_UPDATED_BY = f"{MARKER}-NURSE"

# The DateTimePicker defaults to the current month/year; pick a mid-month day
# (unique in the grid) and a fixed time. The picker records the entered wall
# clock as a UTC instant (e.g. 14:30 -> 14:30Z), so the PDF, which renders via
# fmtDateTime() in the pinned timezone, converts it back to local time (BST in
# July -> 15:30). Compute the expected stamp the same way to stay deterministic.
from datetime import timezone as _tzutc

SPOKEN_DAY = 15
SPOKEN_TIME = "14:30"
_today = datetime.now(TZ)
SPOKEN_UTC = datetime(
    _today.year, _today.month, SPOKEN_DAY, 14, 30, tzinfo=_tzutc.utc
)
EXPECTED_STAMP = SPOKEN_UTC.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


def packed(s):
    return "".join(s.split())


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
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
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


def text_input(scope, label):
    return scope.get_by_text(label, exact=True).locator("xpath=following-sibling::input")


def fill_spoken_to(dialog):
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(SPOKEN_DAY), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(SPOKEN_TIME)


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
                timezone_id=TZ_ID,
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- Enter NOK details + spoken-to timestamp via the real UI ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"

            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=15000)
            dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()

            text_input(dialog, "Name").fill(NOK_NAME)
            text_input(dialog, "Relationship").fill(NOK_REL)
            text_input(dialog, "Contact details").fill(NOK_CONTACT)
            fill_spoken_to(dialog)
            text_input(dialog, "Updated by (staff name)").fill(NOK_UPDATED_BY)

            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            page.get_by_role("tab", name="Next of kin").click()
            for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / f"nokpdf_{MARKER}_recorded.png"))

            # ---- Export + download the handover PDF ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dlg = page.get_by_role("dialog")
            download_btn = dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # ---- NOK details render in the PDF ----
        for token in (NOK_NAME, NOK_REL, NOK_CONTACT, NOK_UPDATED_BY):
            assert token in packed_text, f"NOK value '{token}' missing from handover PDF"

        # ---- Spoken-to timestamp renders in dd/mm/yyyy, HH:MM form ----
        stamp_packed = packed(EXPECTED_STAMP)
        assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", stamp_packed), (
            f"expected stamp '{stamp_packed}' not in dd/mm/yyyy,HH:MM form (test bug)"
        )
        assert stamp_packed in packed_text, (
            f"spoken-to timestamp '{EXPECTED_STAMP}' missing from handover PDF; "
            f"NOK region: {packed_text[packed_text.find('NOK:'):packed_text.find('NOK:')+200]!r}"
        )

        # ---- The whole NOK line is wired together correctly ----
        expected_line = packed(
            f"NOK: {NOK_NAME} ({NOK_REL}) {NOK_CONTACT} "
            f"[Spoken to {EXPECTED_STAMP} by {NOK_UPDATED_BY}]"
        )
        assert expected_line in packed_text, (
            f"NOK line not rendered as expected.\nwant: {expected_line!r}\n"
            f"got around NOK: {packed_text[packed_text.find('NOK:'):packed_text.find('NOK:')+200]!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: NOK details and 'Last updated / spoken to' timestamp entered via the "
            "UI render correctly in the handover PDF"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
