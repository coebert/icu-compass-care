"""
End-to-end test: the EXACT "To <destination>" formatting (a literal capital
"To" followed by a single space, then the destination verbatim) is rendered in
the exported handover PDF for ward, theatre, and step-down discharge
destinations. This is a formatting-regression guard: it fails if the prefix
ever drifts to "to ", "To:", "To  " (double space), "->", or a glued
"ToDestination".

Where handover-pdf-discharge-destination-types.e2e.py asserts destinations
against whitespace-STRIPPED PDF text (which cannot detect a spacing/punctuation
regression), THIS test extracts SPACING-PRESERVING text (plain `pdftotext`, no
-raw) and asserts the precise byte-for-byte "To <token>" string, while proving
the wrong variants are absent.

Destinations are single tokens so the "To <token>" pair cannot be split by
table-cell line wrapping — keeping the exact-spacing assertion reliable.

The handover sheet's "Location / status" column (location() in
src/lib/handover-pdf.ts) renders `To ${discharge_destination}` for a discharged
patient. Discharged records live in the archive view.

Steps:
  1. Seed three discharged patients (ward, theatre, step-down destinations) on
     distinct beds, each a distinct single-token destination.
  2. Sign in, open /patients, toggle Archive, export + download the PDF.
  3. Extract spacing-preserving text and assert the exact "To <token>" appears
     for each, and that "To<token>", "To  <token>", "to <token>", "To:<token>"
     do NOT appear.

Throwaway clinician user + patients are created/cleaned via the admin REST API.
Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-discharge-to-formatting.e2e.py
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

MARKER = f"E2ETOFMT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
STAMP = str(int(time.time()))[-5:]

DISCHARGE_DATE = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=9)).isoformat()

# SHORT single-token destinations so "To <token>" stays on ONE physical line
# (the narrow "Location / status" column wraps long tokens), which keeps the
# exact-spacing assertion reliable. The stamp keeps them unique vs real data.
CASES = [
    {"name": f"TOF.WARD.{STAMP}", "bed": "41", "dest": f"Wd{STAMP}", "label": "ward"},
    {"name": f"TOF.THTR.{STAMP}", "bed": "42", "dest": f"Th{STAMP}", "label": "theatre"},
    {"name": f"TOF.STEP.{STAMP}", "bed": "43", "dest": f"Sd{STAMP}", "label": "step-down"},
]


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


def create_discharged_patient(case):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": case["name"],
            "age": 72,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": case["bed"],
            "status": "discharged",
            "admission_date": ADMISSION_DATE,
            "discharge_date": DISCHARGE_DATE,
            "discharge_destination": case["dest"],
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


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
            headers=admin_headers(),
            timeout=30,
        )
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def extract_pdf_text_spaced(pdf_path):
    """Plain pdftotext (NOT -raw) preserves intra-line spacing, so we can assert
    the exact 'To <token>' punctuation/spacing. Kept AS-IS (newlines intact) so
    a short destination stays on its own physical line and no join step can
    introduce or hide a space."""
    out = subprocess.run(
        ["pdftotext", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout


def main():
    user_id = None
    patient_ids = []
    try:
        user_id, email = create_user()
        for case in CASES:
            patient_ids.append(create_discharged_patient(case))

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

            page.get_by_role("button", name="Archive").click()
            for case in CASES:
                expect(
                    page.get_by_text(case["name"], exact=False).first
                ).to_be_visible(timeout=15000)

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

        text = extract_pdf_text_spaced(pdf_path)

        for case in CASES:
            dest = case["dest"]
            good = f"To {dest}"  # exact: capital T, one space, then destination

            assert good in text, (
                f"[{case['label']}] exact '{good}' not found in PDF; "
                f"the 'To ' prefix formatting has regressed. "
                f"Context: {text[max(0, text.find(dest) - 15):text.find(dest) + len(dest)]!r}"
            )

            # Explicitly reject the common regressions.
            assert f"To{dest}" not in text, f"[{case['label']}] 'To' is glued to destination (missing space)"
            assert f"To  {dest}" not in text, f"[{case['label']}] double space after 'To'"
            assert f"to {dest}" not in text, f"[{case['label']}] lowercase 'to' prefix"
            assert f"To: {dest}" not in text and f"To:{dest}" not in text, (
                f"[{case['label']}] unexpected colon after 'To'"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: ward, theatre and step-down destinations render with exact "
            "'To <destination>' formatting (single space, no colon, correct case)"
        )
        return 0
    finally:
        cleanup(patient_ids, user_id)


if __name__ == "__main__":
    sys.exit(main())
