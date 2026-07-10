"""
End-to-end test: two DIFFERENT microbiology specimens for the SAME patient on
the SAME day, each with an older and a newer result, export cleanly — every
specimen row shows only ITS OWN latest findings, with no cross-contamination
between specimens and no superseded (older) result leaking.

The handover sheet's "Key microbiology" column is built by microbiology() ->
latestMicrobiologyPerSpecimen() in src/lib/handover-pdf.ts, which keeps the
newest result per specimen_type (by result_at) and renders one line each:

  <specimen>: <latest findings> (dd/mm/yyyy HH:MM)

This test seeds, for the same patient and same calendar day:
  - Blood culture: an OLDER result (09:00) and a NEWER result (15:30)
  - Sputum:        an OLDER result (10:00) and a NEWER result (14:45)

and asserts the export shows:
  - Blood culture -> only its NEWER findings (older Blood-culture absent)
  - Sputum        -> only its NEWER findings (older Sputum absent)
  - each specimen's latest findings sit in its own row, not bleeding into the
    other specimen's line (no cross-contamination).

Throwaway clinician user + patient + microbiology rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-two-specimens-same-day.e2e.py
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

MARKER = f"E2EMICRO2{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"MIC2.{str(int(time.time()))[-4:]}"

# Same calendar day for every result (a recent past day, all UTC).
DAY = (datetime.now(timezone.utc) - timedelta(days=1)).date()


def at(hour, minute):
    return datetime(DAY.year, DAY.month, DAY.day, hour, minute, tzinfo=timezone.utc)


SPEC_A = "Blood culture"
SPEC_B = "Sputum"

A_OLD = f"Blood culture old no growth {MARKER}"
A_NEW = f"Blood culture new E.coli gram-neg {MARKER}"
B_OLD = f"Sputum old mixed flora {MARKER}"
B_NEW = f"Sputum new Pseudomonas heavy {MARKER}"

MICRO_ROWS = [
    {"specimen_type": SPEC_A, "findings": A_OLD, "result_at": at(9, 0).isoformat()},
    {"specimen_type": SPEC_A, "findings": A_NEW, "result_at": at(15, 30).isoformat()},
    {"specimen_type": SPEC_B, "findings": B_OLD, "result_at": at(10, 0).isoformat()},
    {"specimen_type": SPEC_B, "findings": B_NEW, "result_at": at(14, 45).isoformat()},
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
            "age": 59,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "8",
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

        # Each specimen shows only its own LATEST findings.
        assert packed(A_NEW) in packed_text, "latest Blood culture findings missing from PDF"
        assert packed(B_NEW) in packed_text, "latest Sputum findings missing from PDF"

        # Older results for both specimens are superseded and absent.
        assert packed(A_OLD) not in packed_text, "superseded Blood culture result leaked into PDF"
        assert packed(B_OLD) not in packed_text, "superseded Sputum result leaked into PDF"

        # No cross-contamination: each specimen line carries its own latest
        # findings, not the other specimen's. Verify the latest findings sit
        # under the correct specimen label within the row window.
        a_idx = packed_text.find(packed(f"{SPEC_A}:"))
        b_idx = packed_text.find(packed(f"{SPEC_B}:"))
        assert a_idx != -1, "Blood culture specimen label missing from PDF"
        assert b_idx != -1, "Sputum specimen label missing from PDF"

        # Bound each specimen window at the NEXT specimen label so a row cannot
        # spill into (or be contaminated by) the adjacent specimen's line.
        bounds = sorted([a_idx, b_idx])
        a_end = bounds[1] if bounds[1] > a_idx else len(packed_text)
        b_end = bounds[1] if bounds[1] > b_idx else len(packed_text)
        a_window = packed_text[a_idx:a_end]
        b_window = packed_text[b_idx:b_end]

        assert packed(A_NEW) in a_window, (
            f"Blood culture row does not carry its own latest findings; window={a_window!r}"
        )
        assert packed(B_NEW) in b_window, (
            f"Sputum row does not carry its own latest findings; window={b_window!r}"
        )
        # Cross-check: the other specimen's findings must NOT be inside this row.
        assert packed(B_NEW) not in a_window, "Sputum findings contaminated the Blood culture row"
        assert packed(A_NEW) not in b_window, "Blood culture findings contaminated the Sputum row"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: two same-day specimens each render only their own latest "
            "microbiology result in the handover PDF, with no cross-contamination"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
