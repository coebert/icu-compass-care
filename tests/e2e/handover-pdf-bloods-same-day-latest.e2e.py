"""
End-to-end test: when Bloods have MULTIPLE entries on the SAME calendar day
(differing only by time-of-day), the handover PDF's Bloods key line shows ONLY
the most recent entry's findings AND timestamp — the earlier same-day results
must not appear.

The investigations column renders the newest result per category by result_at
(mostRecentInvestigation in src/lib/handover-pdf.ts), formatted with
fmtDateTime() as "dd/mm/yyyy, HH:MM". Same-day entries share the date, so this
test proves selection is by full timestamp (not just date) and that the exact
time-of-day rendered belongs to the latest entry.

Steps:
  1. Seed one patient with three Bloods results on the same day (morning,
     midday, evening) inserted OUT OF ORDER, plus a CXR/CT for context.
  2. Sign in, export + download the handover PDF from the real UI.
  3. Assert the PDF's packed text contains only the EVENING Bloods finding and
     its "dd/mm/yyyy, HH:MM" timestamp, and neither earlier same-day finding
     nor its timestamp appears.

Browser timezone is pinned so the expected timestamp strings are deterministic.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-bloods-same-day-latest.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
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

MARKER = f"E2EPDFSDB{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "S.D.B."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]
BLOODS_MORNING = f"BAM{SUFFIX}"
BLOODS_MIDDAY = f"BMID{SUFFIX}"
BLOODS_EVENING = f"BPM{SUFFIX}"  # newest -> must be the one shown
CXR_FIND = f"CXR{SUFFIX}"
CT_FIND = f"CTC{SUFFIX}"

# Anchor to a fixed calendar day (yesterday, in the pinned tz) so all three
# Bloods entries share the SAME date but differ by time-of-day.
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(hour, minute):
    """A UTC datetime for the given local time-of-day on the anchor day."""
    local = datetime(_day.year, _day.month, _day.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


BLOODS_MORNING_AT = at_local(7, 15)
BLOODS_MIDDAY_AT = at_local(12, 40)
BLOODS_EVENING_AT = at_local(19, 5)  # latest same-day entry
CXR_AT = at_local(9, 0)
CT_AT = at_local(10, 30)


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
    """Mirror fmtDateTime(): en-GB 'dd/mm/yyyy, HH:MM' in the pinned timezone."""
    return dt_utc.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


def packed_datetime(dt_utc):
    return "".join(fmt_datetime_engb(dt_utc).split())


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
            "age": 63,
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

        # Three same-day Bloods, inserted OUT OF ORDER (midday, evening, morning).
        add_investigation(patient_id, "Bloods", BLOODS_MIDDAY, iso(BLOODS_MIDDAY_AT))
        add_investigation(patient_id, "Bloods", BLOODS_EVENING, iso(BLOODS_EVENING_AT))
        add_investigation(patient_id, "Bloods", BLOODS_MORNING, iso(BLOODS_MORNING_AT))
        add_investigation(patient_id, "CXR", CXR_FIND, iso(CXR_AT))
        add_investigation(patient_id, "CT chest", CT_FIND, iso(CT_AT))

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

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dialog = page.get_by_role("dialog")
            download_btn = dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        _, packed = extract_pdf_text(pdf_path)

        evening_stamp = packed_datetime(BLOODS_EVENING_AT)
        assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", evening_stamp), (
            f"expected timestamp '{evening_stamp}' not in dd/mm/yyyy,HH:MM form (test bug)"
        )

        # ---- Only the latest (evening) Bloods finding + timestamp shown ----
        assert f"Bloods:{BLOODS_EVENING}({evening_stamp})" in packed, (
            f"Bloods line must show newest same-day entry '{BLOODS_EVENING}' at "
            f"'{evening_stamp}'; packed around Bloods: "
            f"{packed[packed.find('Bloods:'):packed.find('Bloods:')+50]!r}"
        )

        # ---- Earlier same-day Bloods findings must be absent ----
        for older in (BLOODS_MORNING, BLOODS_MIDDAY):
            assert older not in packed, (
                f"earlier same-day Bloods finding '{older}' leaked into the PDF"
            )

        # ---- Their time-of-day stamps must not appear either ----
        for older_at in (BLOODS_MORNING_AT, BLOODS_MIDDAY_AT):
            older_stamp = packed_datetime(older_at)
            if older_stamp != evening_stamp:
                assert older_stamp not in packed, (
                    f"earlier same-day timestamp '{older_stamp}' leaked into the PDF"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: same-day Bloods show only the latest entry's findings and "
            f"timestamp ({evening_stamp})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
