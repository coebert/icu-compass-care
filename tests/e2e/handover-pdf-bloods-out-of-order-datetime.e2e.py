"""
End-to-end test: the exported handover PDF selects the most recent Bloods entry
strictly by recorded datetime (result_at) — NOT by insertion order — across a
mix of same-day and different-day entries inserted out of chronological order.

investigations() in src/lib/handover-pdf.ts uses mostRecentInvestigation(),
which reduces by isAtLeastAsRecent() comparing result_at. This test seeds five
Bloods entries for one patient:

  - three on the SAME (most recent) day at different times of day, and
  - two on EARLIER days,

all inserted in a deliberately scrambled order (an earlier-day entry inserted
LAST, the true-newest inserted in the middle, etc.). It then drives the real UI
export and asserts against the PDF text that:

  1. The Bloods line shows the finding + timestamp of the entry with the newest
     result_at (a same-day evening entry), formatted 'dd/mm/yyyy, HH:MM'.
  2. None of the four superseded Bloods findings/timestamps appear.

Browser timezone is pinned (Europe/London) so expected timestamp strings are
deterministic. Throwaway clinician user + patient (+investigations) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-bloods-out-of-order-datetime.e2e.py
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

MARKER = f"E2EPDFBOO{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "B.O.O."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]

# Anchor: "today" in the pinned timezone (most recent day used for same-day set).
_today = datetime.now(TZ).date()


def at_local(days_ago, hour, minute):
    d = _today - timedelta(days=days_ago)
    local = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


# Five Bloods entries. `newest` flags the one that MUST be selected (latest
# result_at overall: today 20:10). Findings are unique so we can detect leaks.
BLOODS = [
    {"find": f"BDAY2M{SUFFIX}", "at": at_local(2, 9, 30)},    # 2 days ago, morning
    {"find": f"BDAY1E{SUFFIX}", "at": at_local(1, 21, 45)},   # yesterday, evening
    {"find": f"BTODAM{SUFFIX}", "at": at_local(0, 7, 5)},     # today, morning
    {"find": f"BTODEV{SUFFIX}", "at": at_local(0, 20, 10), "newest": True},  # today, evening (NEWEST)
    {"find": f"BTODMD{SUFFIX}", "at": at_local(0, 13, 0)},    # today, midday
]

# Scrambled insertion order (NOT chronological): yesterday, today-evening(newest),
# 2-days-ago, today-midday, today-morning. The true-newest is not inserted last.
INSERT_ORDER = [1, 3, 0, 4, 2]

CXR_FIND = f"CXR{SUFFIX}"
CT_FIND = f"CTC{SUFFIX}"
CXR_AT = at_local(1, 10, 0)
CT_AT = at_local(2, 11, 0)


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
            "age": 64,
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

        # Insert Bloods in scrambled (non-chronological) order.
        for idx in INSERT_ORDER:
            entry = BLOODS[idx]
            add_investigation(patient_id, "Bloods", entry["find"], iso(entry["at"]))
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

        raw_text, packed_text = extract_pdf_text(pdf_path)

        newest = next(b for b in BLOODS if b.get("newest"))
        newest_stamp = fmt_datetime_engb(newest["at"])

        # 1. Bloods line shows the newest finding + its correctly formatted stamp.
        expected_line = packed(f"Bloods: {newest['find']} ({newest_stamp})")
        assert expected_line in packed_text, (
            f"expected newest Bloods line 'Bloods: {newest['find']} ({newest_stamp})' "
            f"not found — selection did not honour recorded datetime"
        )

        # Timestamps kept (to avoid false positives if an older stamp coincides).
        kept_stamps = {packed(newest_stamp)}

        # 2. No superseded Bloods finding/timestamp leaks into the PDF.
        for b in BLOODS:
            if b.get("newest"):
                continue
            assert packed(b["find"]) not in packed_text, (
                f"superseded Bloods finding '{b['find']}' leaked — wrong entry selected"
            )
            old_stamp = packed(fmt_datetime_engb(b["at"]))
            if old_stamp not in kept_stamps:
                assert old_stamp not in packed_text, (
                    f"superseded Bloods timestamp '{fmt_datetime_engb(b['at'])}' leaked"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: Bloods selection honours recorded datetime across same-day and "
            f"cross-day out-of-order inserts (newest: {newest['find']} @ {newest_stamp})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
