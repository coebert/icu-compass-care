"""
End-to-end test: a SINGLE microbiology specimen with results straddling
midnight — one late on the previous day, one early on the current day — renders
in the handover PDF as ONLY the most recent timestamped findings. The earlier
(previous-day) result for that specimen must be superseded and absent.

This guards the "latest per specimen" logic across a day boundary, where a
naive same-day-only or date-only comparison could keep the wrong result. The
handover sheet's "Key microbiology" column is built by microbiology() ->
latestMicrobiologyPerSpecimen() in src/lib/handover-pdf.ts, which keeps the
newest result per specimen_type by full `result_at` timestamp (not date), and
renders one line:

  <specimen>: <latest findings> (dd/mm/yyyy HH:MM)

Seeded for the same patient and same specimen (Blood culture):
  - PREVIOUS day 23:40 UTC -> older findings
  - CURRENT  day 00:20 UTC -> newer findings (40 minutes later, across midnight)

Assertions on the exported PDF:
  - the specimen line shows the NEWER (current-day) findings,
  - the OLDER (previous-day) findings are absent,
  - the newer timestamp's date is rendered and the older timestamp's date is
    NOT rendered for that specimen line.

Throwaway clinician user + patient + microbiology rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-across-midnight.e2e.py
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

MARKER = f"E2EMICMID{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"MICMID.{str(int(time.time()))[-4:]}"

SPECIMEN = "Blood culture"

# Two results for the same specimen, straddling midnight (both recent, UTC).
# Anchor "today" a couple of days back so the record is unambiguously in range
# and both timestamps are in the past.
TODAY = datetime.now(timezone.utc).replace(
    hour=0, minute=20, second=0, microsecond=0
) - timedelta(days=1)
PREV_AT = TODAY - timedelta(minutes=40)  # previous day 23:40
CURR_AT = TODAY                          # current day 00:20 (newer)

OLD_FINDINGS = f"Blood culture prev-day no growth {MARKER}"
NEW_FINDINGS = f"Blood culture next-day Staph aureus {MARKER}"

MICRO_ROWS = [
    {"specimen_type": SPECIMEN, "findings": OLD_FINDINGS, "result_at": PREV_AT.isoformat()},
    {"specimen_type": SPECIMEN, "findings": NEW_FINDINGS, "result_at": CURR_AT.isoformat()},
]


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
            "bed": "10",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_microbiology(patient_id):
    rows = [{**m, "patient_id": patient_id} for m in MICRO_ROWS]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=rows,
        timeout=30,
    )
    r.raise_for_status()


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
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_microbiology(patient_id)
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

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

        # Only the most recent (current-day) findings render for this specimen.
        assert packed(NEW_FINDINGS) in packed_text, (
            "newest (across-midnight) microbiology findings missing from PDF"
        )
        assert packed(OLD_FINDINGS) not in packed_text, (
            "superseded previous-day microbiology findings leaked into the PDF"
        )

        # The specimen line carries the newer findings under its own label.
        s_idx = packed_text.find(packed(f"{SPECIMEN}:"))
        assert s_idx != -1, "specimen label missing from PDF"
        s_window = packed_text[s_idx:s_idx + 160]
        assert packed(NEW_FINDINGS) in s_window, (
            f"specimen row does not show its latest findings; window={s_window!r}"
        )

        # Date sanity: the newer date renders; the older date differs. If the two
        # dates differ (they straddle midnight), the older date must not appear
        # attached to this specimen line.
        new_date = CURR_AT.strftime("%d/%m/%Y")
        old_date = PREV_AT.strftime("%d/%m/%Y")
        assert new_date != old_date, "test setup error: timestamps did not straddle midnight"
        assert packed(new_date) in s_window, (
            f"newest result date {new_date} not rendered on specimen line; window={s_window!r}"
        )
        assert packed(old_date) not in s_window, (
            f"older previous-day date {old_date} leaked onto specimen line; window={s_window!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: for a single specimen with results across midnight, the "
            "handover PDF renders only the most recent timestamped findings"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
