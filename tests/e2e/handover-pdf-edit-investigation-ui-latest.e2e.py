"""
End-to-end test: editing an EXISTING investigation record through the real UI
(new finding + new time) and then exporting the handover PDF shows ONLY the
edited latest values — the pre-edit finding and timestamp are gone.

Flow (full UI round-trip):
  1. Seed ONE Bloods investigation via the admin API at a pinned old time with
     an OLD finding.
  2. In the patient's Investigations tab, open the record's Edit dialog, replace
     the findings text with a NEW finding, and change the time to a NEW time.
  3. Save, and confirm the "Most recent Bloods" card reflects the new value.
  4. Export the handover PDF from the board and assert the Bloods cell shows
     'Bloods: <new finding> (<new stamp>)' and neither the OLD finding nor the
     OLD timestamp appears.

The DateTimePicker keeps the record's existing (pinned) date and edits only the
time-of-day, so the expected timestamp is deterministic. Browser timezone is
pinned (Europe/London) so both the picker and fmtDateTime() agree.

Throwaway clinician user + patient (+investigation) are created and cleaned up
via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-edit-investigation-ui-latest.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
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

MARKER = f"E2EPDFEDI{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.D.I."

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]

# Pinned old datetime (yesterday, in the pinned tz) and finding.
_day = (datetime.now(TZ) - timedelta(days=1)).date()
OLD_LOCAL = datetime(_day.year, _day.month, _day.day, 8, 0, tzinfo=TZ)
OLD_AT_UTC = OLD_LOCAL.astimezone(timezone.utc)
OLD_FIND = f"BLDOLD{SUFFIX}"

# New time (same pinned date, edited via the time input) and new finding.
NEW_TIME = "15:45"
NEW_FIND = f"BLDNEW{SUFFIX}"
NEW_LOCAL = datetime(_day.year, _day.month, _day.day, 15, 45, tzinfo=TZ)


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_local_aware):
    return dt_local_aware.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


def packed(s):
    return "".join(s.split())


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
            "age": 61,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Mgmt {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_investigation(patient_id, category, findings, result_at):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    ).raise_for_status()


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
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        add_investigation(patient_id, "Bloods", OLD_FIND, iso(OLD_AT_UTC))

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

            # Open the patient detail directly.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # Investigations tab.
            page.get_by_role("tab", name="Investigations").click()
            expect(page.get_by_text(OLD_FIND, exact=False).first).to_be_visible(timeout=15000)

            # Open the record's Edit dialog (Full history edit button).
            page.get_by_role("button", name="Edit investigation").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=10000)

            # Change the finding.
            textarea = dialog.locator("textarea")
            textarea.fill(NEW_FIND)

            # Change the time (keeps the pinned date).
            time_input = dialog.get_by_label("Time")
            time_input.fill(NEW_TIME)

            # Save.
            dialog.get_by_role("button", name="Save changes").click()
            expect(dialog).to_be_hidden(timeout=10000)

            # The most-recent Bloods card should now show the new finding.
            expect(page.get_by_text(NEW_FIND, exact=False).first).to_be_visible(timeout=10000)

            # Export the PDF from the board.
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            pdf_dialog = page.get_by_role("dialog")
            download_btn = pdf_dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        new_stamp = fmt_datetime_engb(NEW_LOCAL)
        old_stamp = fmt_datetime_engb(OLD_LOCAL)

        # 1. PDF reflects the edited latest values.
        expected_line = packed(f"Bloods: {NEW_FIND} ({new_stamp})")
        assert expected_line in packed_text, (
            f"expected edited Bloods line 'Bloods: {NEW_FIND} ({new_stamp})' not found in PDF"
        )

        # 2. Pre-edit finding is gone.
        assert packed(OLD_FIND) not in packed_text, (
            f"pre-edit finding '{OLD_FIND}' still present after edit"
        )

        # 3. Pre-edit timestamp is gone (differs from the new one).
        assert packed(old_stamp) != packed(new_stamp), "test setup: old/new stamps must differ"
        assert packed(old_stamp) not in packed_text, (
            f"pre-edit timestamp '{old_stamp}' still present after edit"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: UI edit of an existing investigation (new finding + time) is "
            f"reflected in the PDF ({NEW_FIND} @ {new_stamp}); old values gone"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
