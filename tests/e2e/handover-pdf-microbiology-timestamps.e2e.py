"""
End-to-end test: microbiology result timestamps in the exported handover PDF
are formatted correctly ('dd/mm/yyyy, HH:MM', en-GB 24h) and match the MOST
RECENT entry per specimen type.

The "Key microbiology" column (src/lib/handover-pdf.ts -> microbiology())
renders one line per specimen using latestMicrobiologyPerSpecimen(), each as
`<specimen>: <findings> (<fmtDateTime(result_at)>)`. fmtDateTime() formats via
toLocaleString("en-GB", { day/month/year 2-digit, hour/minute 2-digit,
hour12:false }) => "dd/mm/yyyy, HH:MM".

This test seeds a patient with MULTIPLE microbiology results per specimen,
inserted OUT OF ORDER and with distinct times-of-day, then drives the real UI
export and asserts against the PDF text:

  1. Each specimen renders the timestamp of its NEWEST result, in the exact
     'dd/mm/yyyy, HH:MM' format, adjacent to the newest finding.
  2. Every superseded (older) result's timestamp is ABSENT (no stale stamps),
     unless that stamp coincides with a kept one.
  3. The newest finding is paired with the newest stamp (packed adjacency).

Browser timezone is pinned (Europe/London) so expected timestamp strings are
deterministic. Throwaway clinician user + patient (+microbiology) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-timestamps.e2e.py
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

MARKER = f"E2EPDFMTS{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.T.S."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]

# Anchor to a fixed calendar day (yesterday, in the pinned tz).
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(days_ago, hour, minute):
    """A UTC datetime for the given local time-of-day on a day near the anchor."""
    d = _day - timedelta(days=days_ago)
    local = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


# (finding, result_at) oldest -> newest, per specimen. Inserted out of order.
MICRO = {
    "Blood culture": [
        (f"BCOLD{SUFFIX}", at_local(2, 8, 5)),
        (f"BCNEW{SUFFIX}", at_local(0, 6, 42)),   # newest -> shown
    ],
    "Urine": [
        (f"UROLD{SUFFIX}", at_local(3, 14, 20)),
        (f"URMID{SUFFIX}", at_local(1, 9, 0)),
        (f"URNEW{SUFFIX}", at_local(0, 17, 55)),  # newest -> shown
    ],
    "Sputum": [
        (f"SPOLD{SUFFIX}", at_local(2, 23, 30)),
        (f"SPNEW{SUFFIX}", at_local(0, 11, 15)),  # newest -> shown
    ],
}


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
    """Mirror fmtDateTime(): en-GB 'dd/mm/yyyy, HH:MM' in the pinned timezone."""
    return dt_utc.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


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
            "age": 71,
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

        for specimen, entries in MICRO.items():
            # Insert out of order (newest first) to prove sorting is by result_at.
            for finding, at in reversed(entries):
                add_microbiology(patient_id, specimen, finding, iso(at))

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

        raw_text, packed = extract_pdf_text(pdf_path)

        assert "Key microbiology" in raw_text, "missing microbiology column header"

        # Timestamps that SHOULD appear (newest per specimen). Collected so we
        # never flag a superseded stamp that happens to coincide with a kept one.
        kept_stamps = set()
        for spec, entries in MICRO.items():
            newest_find, newest_at = entries[-1]
            newest_stamp = fmt_datetime_engb(newest_at)
            packed_stamp = "".join(newest_stamp.split())
            kept_stamps.add(packed_stamp)

            # 1. Newest finding present with its correctly formatted stamp adjacent.
            expected_line = "".join(f"{spec}: {newest_find} ({newest_stamp})".split())
            assert expected_line in packed, (
                f"{spec}: expected '{spec}: {newest_find} ({newest_stamp})' "
                f"(newest finding + formatted timestamp) not found in PDF"
            )

        # 2. Every superseded timestamp is ABSENT (unless it coincides with a kept one).
        for spec, entries in MICRO.items():
            for finding, at in entries[:-1]:
                old_stamp = "".join(fmt_datetime_engb(at).split())
                if old_stamp in kept_stamps:
                    continue
                assert old_stamp not in packed, (
                    f"{spec}: superseded timestamp '{fmt_datetime_engb(at)}' "
                    f"leaked into PDF — not 'latest per specimen only'"
                )
                assert "".join(finding.split()) not in packed, (
                    f"{spec}: superseded finding '{finding}' leaked into PDF"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: microbiology timestamps are formatted 'dd/mm/yyyy, HH:MM' and "
            "match the most recent entry per specimen; no stale stamps leaked"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
