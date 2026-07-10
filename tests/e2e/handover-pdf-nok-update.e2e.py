"""
End-to-end test: UPDATING an existing patient's next-of-kin details and the
"Last updated / spoken to" time through the real Edit UI makes the exported
handover PDF render the UPDATED values — and drop the superseded ones.

Where handover-pdf-nok-spoken-to.e2e.py enters NOK details from scratch, this
test starts from a patient that ALREADY has NOK details (name, relationship,
contact, updated-by, and an old spoken-to timestamp), edits every field via the
Edit dialog, then exports the PDF and asserts:

  - the NEW name/relationship/contact/updated-by and NEW timestamp all render,
    wired together as the single NOK line built by flags() in
    src/lib/handover-pdf.ts:
      NOK: <name> (<relationship>) <contact> [Spoken to <dd/mm/yyyy, HH:MM> by <staff>]
  - none of the OLD (pre-edit) values or the OLD timestamp leak anywhere.

Render timezone is pinned (Europe/London) so fmtDateTime output is
deterministic. The DateTimePicker records the entered wall clock as a UTC
instant (e.g. 16:45 -> 16:45Z), which the PDF renders back in the pinned tz
(BST in July -> 17:45); the seeded OLD timestamp is a UTC ISO the PDF renders
the same way. Expected stamps are computed identically.

Throwaway admin user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-nok-update.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone as _tzutc
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

MARKER = f"NOKUPD{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.O.K.UPD"

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

# --- OLD (seeded) NOK values ---
OLD_NAME = f"{MARKER}-OLDKIN"
OLD_REL = f"{MARKER}-OLDREL"
OLD_CONTACT = f"{MARKER}-OLD07000"
OLD_UPDATED_BY = f"{MARKER}-OLDNURSE"

# --- NEW (edited) NOK values ---
NEW_NAME = f"{MARKER}-NEWKIN"
NEW_REL = f"{MARKER}-NEWREL"
NEW_CONTACT = f"{MARKER}-NEW07999"
NEW_UPDATED_BY = f"{MARKER}-NEWNURSE"

_today = datetime.now(TZ)

# OLD spoken-to timestamp: seeded as a UTC ISO, rendered via fmtDateTime.
OLD_DAY, OLD_H, OLD_M = 5, 9, 0
OLD_SPOKEN_UTC = datetime(_today.year, _today.month, OLD_DAY, OLD_H, OLD_M, tzinfo=_tzutc.utc)
OLD_STAMP = OLD_SPOKEN_UTC.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")

# NEW spoken-to timestamp: entered via the DateTimePicker (wall clock -> UTC).
NEW_DAY = 20
NEW_TIME = "16:45"
NEW_SPOKEN_UTC = datetime(_today.year, _today.month, NEW_DAY, 16, 45, tzinfo=_tzutc.utc)
NEW_STAMP = NEW_SPOKEN_UTC.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


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


def create_patient_with_old_nok():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "nok_name": OLD_NAME,
            "nok_relationship": OLD_REL,
            "nok_contact": OLD_CONTACT,
            "nok_last_updated": OLD_SPOKEN_UTC.isoformat(),
            "nok_last_updated_by": OLD_UPDATED_BY,
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


def set_spoken_to(dialog):
    field = dialog.get_by_text("Last updated / spoken to", exact=True)
    field.locator("xpath=following-sibling::div//button").click()
    popover = dialog.page.locator("[data-radix-popper-content-wrapper]")
    expect(popover).to_be_visible(timeout=10000)
    popover.get_by_text(str(NEW_DAY), exact=True).first.click()
    field.locator("xpath=following-sibling::div//input[@type='time']").fill(NEW_TIME)


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
        patient_id = create_patient_with_old_nok()
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

            # ---- Open the patient; confirm OLD NOK details are showing ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"

            page.get_by_role("tab", name="Next of kin").click()
            expect(page.get_by_text(OLD_NAME, exact=True)).to_be_visible(timeout=15000)

            # ---- Edit every NOK field to the NEW values ----
            page.get_by_role("button", name="Edit").click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=15000)
            dialog.get_by_text("Next of kin", exact=True).scroll_into_view_if_needed()

            text_input(dialog, "Name").fill(NEW_NAME)
            text_input(dialog, "Relationship").fill(NEW_REL)
            text_input(dialog, "Contact details").fill(NEW_CONTACT)
            set_spoken_to(dialog)
            text_input(dialog, "Updated by (staff name)").fill(NEW_UPDATED_BY)

            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)

            # ---- Confirm the NOK tab now shows the NEW details (not the old) ----
            page.get_by_role("tab", name="Next of kin").click()
            for token in (NEW_NAME, NEW_REL, NEW_CONTACT, NEW_UPDATED_BY):
                expect(page.get_by_text(token, exact=True)).to_be_visible(timeout=15000)
            expect(page.get_by_text(OLD_NAME, exact=True)).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / f"nokupd_{MARKER}_recorded.png"))

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

        # ---- Updated NOK line renders in full with the NEW values ----
        stamp_packed = packed(NEW_STAMP)
        assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", stamp_packed), (
            f"expected NEW stamp '{stamp_packed}' not in dd/mm/yyyy,HH:MM form (test bug)"
        )
        expected_line = packed(
            f"NOK: {NEW_NAME} ({NEW_REL}) {NEW_CONTACT} "
            f"[Spoken to {NEW_STAMP} by {NEW_UPDATED_BY}]"
        )
        assert expected_line in packed_text, (
            f"updated NOK line not rendered as expected.\nwant: {expected_line!r}\n"
            f"got around NOK: {packed_text[packed_text.find('NOK:'):packed_text.find('NOK:')+220]!r}"
        )

        # ---- No superseded value or timestamp leaks anywhere ----
        for stale in (OLD_NAME, OLD_REL, OLD_CONTACT, OLD_UPDATED_BY, packed(OLD_STAMP)):
            assert stale not in packed_text, (
                f"superseded NOK value '{stale}' leaked into the handover PDF"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: updating NOK details + spoken-to time via the UI renders the new "
            "values in the handover PDF with no stale values leaking"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
