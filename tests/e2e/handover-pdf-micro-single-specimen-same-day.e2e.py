"""
End-to-end test: when a SINGLE microbiology specimen has multiple results on the
SAME day at different times, the exported handover PDF renders ONLY the latest
findings + timestamp for that specimen — earlier same-day results never appear.

microbiology() in src/lib/handover-pdf.ts uses latestMicrobiologyPerSpecimen(),
which keeps the newest result per specimen by result_at. This test seeds three
"Sputum" results for one patient, all on the SAME (pinned) day but at different
times of day, inserted OUT OF ORDER, then drives the real UI export and asserts:

  1. The Sputum line shows the newest same-day finding + its timestamp,
     formatted 'dd/mm/yyyy, HH:MM'.
  2. The two superseded same-day Sputum findings/timestamps are ABSENT.
  3. Exactly one Sputum line is rendered (no duplicate specimen blocks).

Browser timezone is pinned (Europe/London) so expected timestamp strings are
deterministic. Throwaway clinician user + patient (+microbiology) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-micro-single-specimen-same-day.e2e.py
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

MARKER = f"E2EPDFMSD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.S.D."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]

# Anchor to a fixed calendar day (yesterday, in the pinned tz) so all three
# Sputum results share the SAME date but differ by time-of-day.
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(hour, minute):
    local = datetime(_day.year, _day.month, _day.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


SPECIMEN = "Sputum"
SP_MORNING = f"SPAM{SUFFIX}"
SP_MIDDAY = f"SPMID{SUFFIX}"
SP_EVENING = f"SPPM{SUFFIX}"  # newest same-day -> must be the one shown

SP_MORNING_AT = at_local(7, 50)
SP_MIDDAY_AT = at_local(12, 25)
SP_EVENING_AT = at_local(18, 35)  # latest same-day entry


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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Mgmt {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_microbiology(patient_id, specimen_type, findings, result_at):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "specimen_type": specimen_type,
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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
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

        # Three same-day Sputum results, inserted OUT OF ORDER (midday, evening, morning).
        add_microbiology(patient_id, SPECIMEN, SP_MIDDAY, iso(SP_MIDDAY_AT))
        add_microbiology(patient_id, SPECIMEN, SP_EVENING, iso(SP_EVENING_AT))
        add_microbiology(patient_id, SPECIMEN, SP_MORNING, iso(SP_MORNING_AT))

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

        assert "Key microbiology" in raw_text, "missing microbiology column header"

        newest_stamp = fmt_datetime_engb(SP_EVENING_AT)

        # 1. Sputum line shows the newest same-day finding + its formatted timestamp.
        expected_line = packed(f"{SPECIMEN}: {SP_EVENING} ({newest_stamp})")
        assert expected_line in packed_text, (
            f"expected newest Sputum line '{SPECIMEN}: {SP_EVENING} ({newest_stamp})' not found"
        )

        kept_stamps = {packed(newest_stamp)}

        # 2. Superseded same-day Sputum findings/timestamps are ABSENT.
        for find, at in [(SP_MORNING, SP_MORNING_AT), (SP_MIDDAY, SP_MIDDAY_AT)]:
            assert packed(find) not in packed_text, (
                f"superseded Sputum finding '{find}' leaked — not 'latest same-day only'"
            )
            old_stamp = packed(fmt_datetime_engb(at))
            if old_stamp not in kept_stamps:
                assert old_stamp not in packed_text, (
                    f"superseded Sputum timestamp '{fmt_datetime_engb(at)}' leaked"
                )

        # 3. Exactly one Sputum line (no duplicate specimen blocks).
        count = packed_text.count(f"{SPECIMEN}:")
        assert count == 1, f"expected exactly one '{SPECIMEN}:' line, found {count}"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: single specimen with same-day results collapses to the latest "
            f"findings + timestamp ({SP_EVENING} @ {newest_stamp})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
