"""
End-to-end test: the "Key microbiology" column in the exported handover PDF
lists specimen blocks in NEWEST-FIRST order.

microbiology() (src/lib/handover-pdf.ts) renders one line per specimen using
latestMicrobiologyPerSpecimen(), which sorts specimens by each specimen's
newest result_at, DESCENDING. So the specimen whose latest result is most
recent must appear first, and the specimen whose latest result is oldest must
appear last.

This test seeds a patient with several specimen types, each with multiple
results, such that the "latest per specimen" times produce a clear expected
ordering. Records are inserted OUT OF ORDER (both across specimens and within
each specimen) to prove ordering derives from result_at, not insertion order.
It then drives the real UI export and asserts, against the PDF text, that the
specimen lines appear in the expected newest-first sequence.

Throwaway clinician user + patient (+microbiology) are created and cleaned up
via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-order-newest-first.e2e.py
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

MARKER = f"E2EPDFMORD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.O.R."

SUFFIX = str(int(time.time()))[-6:]
now = datetime.now(timezone.utc)

# Per specimen: list of (finding, result_at) inserted out of order. The newest
# result_at per specimen determines that specimen's position (newest first).
# Expected final order (newest latest-result -> oldest): Sputum, Urine,
# Blood culture, Wound.
MICRO = {
    "Blood culture": [
        (f"BCOLD{SUFFIX}", now - timedelta(days=4)),
        (f"BCNEW{SUFFIX}", now - timedelta(hours=30)),   # latest: -30h
    ],
    "Urine": [
        (f"UROLD{SUFFIX}", now - timedelta(days=5)),
        (f"URNEW{SUFFIX}", now - timedelta(hours=10)),   # latest: -10h
    ],
    "Sputum": [
        (f"SPOLD{SUFFIX}", now - timedelta(days=2)),
        (f"SPNEW{SUFFIX}", now - timedelta(hours=1)),    # latest: -1h (most recent)
    ],
    "Wound swab": [
        (f"WSOLD{SUFFIX}", now - timedelta(days=8)),
        (f"WSNEW{SUFFIX}", now - timedelta(days=3)),     # latest: -3d (oldest)
    ],
}

# Specimen names ordered by their newest result_at, newest first.
EXPECTED_ORDER = ["Sputum", "Urine", "Blood culture", "Wound swab"]


def iso(dt):
    return dt.isoformat()


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

        # Insert specimens and entries out of order to prove sort is by result_at.
        for specimen in ["Wound swab", "Blood culture", "Sputum", "Urine"]:
            for finding, at in reversed(MICRO[specimen]):
                add_microbiology(patient_id, specimen, finding, iso(at))

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

        # Locate each specimen's line by its NEWEST finding (uniquely tied to it).
        positions = {}
        for spec in EXPECTED_ORDER:
            newest_find = MICRO[spec][-1][0]
            idx = packed.find("".join(newest_find.split()))
            assert idx != -1, f"{spec}: newest finding '{newest_find}' missing from PDF"
            positions[spec] = idx

        actual_order = sorted(EXPECTED_ORDER, key=lambda s: positions[s])
        assert actual_order == EXPECTED_ORDER, (
            "microbiology specimen blocks are not in newest-first order:\n"
            f"  expected: {EXPECTED_ORDER}\n"
            f"  actual:   {actual_order}\n"
            f"  positions: {positions}"
        )

        # Explicit pairwise monotonic check for a clearer failure message.
        for earlier, later in zip(EXPECTED_ORDER, EXPECTED_ORDER[1:]):
            assert positions[earlier] < positions[later], (
                f"'{earlier}' (newer latest-result) must appear before "
                f"'{later}' (older latest-result) in the PDF"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: microbiology specimen blocks render newest-first "
            f"({' -> '.join(EXPECTED_ORDER)})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
