"""
Regression test: updating microbiology records IN PLACE must leave no trace of
the superseded (pre-update) findings or timestamps anywhere in the exported
handover PDF.

Microbiology results support in-place edits (updateMicrobiology server fn /
REST PATCH by row id). This test guards against a regression where an edited
row's OLD findings or OLD result timestamp leak into the PDF — either in the
"Key microbiology" column or bleeding into the investigations columns.

Flow:
  1. Create a throwaway clinician + patient.
  2. Seed several microbiology rows (distinct specimens), remembering each row id
     and its original findings + result_at.
  3. UPDATE each row IN PLACE (same id) via REST PATCH — new findings + a new
     result_at at a distinct time-of-day, so old and new stamps never coincide.
  4. Export the handover PDF through the real Preview/Download UI.
  5. Assert:
     - every NEW finding and its correctly formatted NEW timestamp appear;
     - every superseded OLD finding is ABSENT anywhere in the PDF;
     - every superseded OLD timestamp is ABSENT anywhere in the PDF
       (including the investigations section), unless it coincides with a
       still-rendered stamp (guarded — here they never do by construction).

Browser timezone pinned (Europe/London) so fmtDateTime output is deterministic.
Throwaway user + patient (+microbiology) cleaned up via the admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-inplace-update-no-stale.e2e.py
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

MARKER = f"E2EMICROUPD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"I.P.U.{str(int(time.time()))[-4:]}"

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)
SUFFIX = str(int(time.time()))[-6:]

_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(days_ago, hour, minute):
    d = _day - timedelta(days=days_ago)
    local = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


# specimen -> (old finding, old_at) and (new finding, new_at). Distinct times so
# no old/new stamp collides. All edits are IN PLACE on the same row id.
SPECS = {
    "Blood culture": {
        "old": (f"BCOLD{SUFFIX}", at_local(3, 8, 5)),
        "new": (f"BCNEW{SUFFIX}", at_local(0, 6, 42)),
    },
    "Urine": {
        "old": (f"UROLD{SUFFIX}", at_local(4, 14, 20)),
        "new": (f"URNEW{SUFFIX}", at_local(0, 17, 55)),
    },
    "CSF": {
        "old": (f"CSFOLD{SUFFIX}", at_local(2, 23, 30)),
        "new": (f"CSFNEW{SUFFIX}", at_local(0, 11, 15)),
    },
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
            "age": 58,
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
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "specimen_type": specimen_type,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def update_microbiology_in_place(row_id, findings, result_at):
    """In-place edit of an existing row (same id) — the update path under test."""
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/microbiology_results?id=eq.{row_id}",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={"findings": findings, "result_at": result_at},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    assert body and body[0]["id"] == row_id, "PATCH did not update the same row id"
    return body[0]


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

        # Seed rows, then edit each IN PLACE (same id).
        for specimen, data in SPECS.items():
            old_find, old_at = data["old"]
            new_find, new_at = data["new"]
            row_id = add_microbiology(patient_id, specimen, old_find, iso(old_at))
            update_microbiology_in_place(row_id, new_find, iso(new_at))

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
            assert "/auth" not in page.url, f"redirected to /auth: {page.url}"

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

        # Stamps that legitimately appear (the post-update values).
        kept_stamps = set()
        for specimen, data in SPECS.items():
            new_find, new_at = data["new"]
            kept_stamps.add("".join(fmt_datetime_engb(new_at).split()))

        # 1. Every updated row renders with its NEW finding + NEW timestamp.
        for specimen, data in SPECS.items():
            new_find, new_at = data["new"]
            new_stamp = fmt_datetime_engb(new_at)
            expected = "".join(f"{specimen}: {new_find} ({new_stamp})".split())
            assert expected in packed, (
                f"{specimen}: expected updated '{specimen}: {new_find} ({new_stamp})' in PDF"
            )

        # 2. No superseded finding appears ANYWHERE in the PDF.
        for specimen, data in SPECS.items():
            old_find, _ = data["old"]
            assert old_find not in packed, (
                f"{specimen}: superseded finding '{old_find}' leaked into the PDF"
            )

        # 3. No superseded timestamp appears ANYWHERE (incl. investigations),
        #    unless it coincides with a still-rendered stamp (never here).
        for specimen, data in SPECS.items():
            _, old_at = data["old"]
            old_stamp = "".join(fmt_datetime_engb(old_at).split())
            if old_stamp in kept_stamps:
                continue
            assert old_stamp not in packed, (
                f"{specimen}: superseded timestamp '{fmt_datetime_engb(old_at)}' "
                f"leaked into the PDF after in-place update"
            )

        print("PASS: in-place microbiology edits leave no superseded findings/timestamps in the PDF")
        for specimen, data in SPECS.items():
            new_find, new_at = data["new"]
            old_find, old_at = data["old"]
            print(
                f"  {specimen}: '{old_find}'@{fmt_datetime_engb(old_at)} -> "
                f"'{new_find}'@{fmt_datetime_engb(new_at)} (old gone, new shown)"
            )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
