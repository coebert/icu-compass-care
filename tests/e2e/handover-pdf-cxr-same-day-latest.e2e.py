"""
End-to-end test: when multiple CXR entries exist on the SAME day at different
times, the exported handover PDF shows ONLY the most recent CXR findings and its
timestamp for that category — selection is by recorded datetime (result_at).

investigations() in src/lib/handover-pdf.ts uses mostRecentInvestigation(),
reducing by isAtLeastAsRecent() on result_at. This test seeds three CXR entries
for one patient, all on the SAME (pinned) day but at different times of day,
inserted OUT OF ORDER, then drives the real UI export and asserts:

  1. The CXR line shows the newest-same-day finding + its timestamp, formatted
     'dd/mm/yyyy, HH:MM'.
  2. The two superseded same-day CXR findings/timestamps are ABSENT.
  3. Bloods (a separate category) still renders its own key finding — proving
     the "latest per category" rule is scoped correctly.

Browser timezone is pinned (Europe/London) so expected timestamp strings are
deterministic. Throwaway clinician user + patient (+investigations) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-cxr-same-day-latest.e2e.py
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

MARKER = f"E2EPDFCXR{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "C.X.R."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]

# Anchor to a fixed calendar day (yesterday, in the pinned tz) so all three CXR
# entries share the SAME date but differ by time-of-day.
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(hour, minute):
    local = datetime(_day.year, _day.month, _day.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


CXR_MORNING = f"CXRAM{SUFFIX}"
CXR_MIDDAY = f"CXRMID{SUFFIX}"
CXR_EVENING = f"CXRPM{SUFFIX}"  # newest same-day -> must be the one shown

CXR_MORNING_AT = at_local(8, 20)
CXR_MIDDAY_AT = at_local(13, 15)
CXR_EVENING_AT = at_local(19, 40)  # latest same-day entry

# A separate category to prove scoping.
BLOODS_FIND = f"BLD{SUFFIX}"
BLOODS_AT = at_local(9, 0)


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
    """Mirror fmtDateTime(): en-GB 'dd/mm/yyyy, HH:MM' in the pinned timezone."""
    return dt_utc.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


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
            "age": 62,
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

        # Three same-day CXR entries, inserted OUT OF ORDER (midday, evening, morning).
        add_investigation(patient_id, "CXR", CXR_MIDDAY, iso(CXR_MIDDAY_AT))
        add_investigation(patient_id, "CXR", CXR_EVENING, iso(CXR_EVENING_AT))
        add_investigation(patient_id, "CXR", CXR_MORNING, iso(CXR_MORNING_AT))
        add_investigation(patient_id, "Bloods", BLOODS_FIND, iso(BLOODS_AT))

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

        raw_text, packed_text = extract_pdf_text(pdf_path)

        newest_stamp = fmt_datetime_engb(CXR_EVENING_AT)

        # 1. CXR line shows the newest same-day finding + its formatted timestamp.
        expected_line = packed(f"CXR: {CXR_EVENING} ({newest_stamp})")
        assert expected_line in packed_text, (
            f"expected newest CXR line 'CXR: {CXR_EVENING} ({newest_stamp})' not found"
        )

        kept_stamps = {packed(newest_stamp)}

        # 2. Superseded same-day CXR findings/timestamps are ABSENT.
        for find, at in [(CXR_MORNING, CXR_MORNING_AT), (CXR_MIDDAY, CXR_MIDDAY_AT)]:
            assert packed(find) not in packed_text, (
                f"superseded CXR finding '{find}' leaked — not 'latest same-day only'"
            )
            old_stamp = packed(fmt_datetime_engb(at))
            if old_stamp not in kept_stamps:
                assert old_stamp not in packed_text, (
                    f"superseded CXR timestamp '{fmt_datetime_engb(at)}' leaked"
                )

        # 3. Bloods (separate category) still renders its key finding.
        assert packed(f"Bloods:{BLOODS_FIND}") in packed_text, (
            "Bloods key finding missing — category scoping broken"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: same-day CXR entries collapse to the most recent findings + "
            f"timestamp ({CXR_EVENING} @ {newest_stamp})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
