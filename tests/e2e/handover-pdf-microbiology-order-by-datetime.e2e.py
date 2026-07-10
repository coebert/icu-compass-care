"""
End-to-end test: microbiology ordering and "most recent" selection in the
handover PDF are driven strictly by the recorded `result_at` datetime, NOT by
the order rows were inserted / received.

The handover sheet's "Key microbiology" column is built by microbiology() ->
latestMicrobiologyPerSpecimen() in src/lib/handover-pdf.ts:
  - one row per specimen type, choosing the newest `result_at`;
  - specimens ordered most-recent-first by their winning `result_at`.

To prove this is datetime-driven and insertion-order-independent, three
specimens are seeded with two results each, inserted ONE AT A TIME in a
deliberately scrambled order that is anti-correlated with the true datetimes:

  insertion #1: CSF  latest      (should render LAST)
  insertion #2: Blood culture  stale  (older; must be superseded)
  insertion #3: Sputum stale           (older; must be superseded)
  insertion #4: CSF  stale             (older; must be superseded)
  insertion #5: Blood culture  latest  (should render FIRST)
  insertion #6: Sputum latest          (should render SECOND)

Sequential single-row inserts make the DB's natural (ctid) row order match
this scramble, so the client receives rows in insertion order — yet the PDF
must reorder by datetime.

True datetimes (newest -> oldest winners):
  Blood culture latest  = now - 1h   -> specimen appears 1st
  Sputum        latest  = now - 5h   -> specimen appears 2nd
  CSF           latest  = now - 20h  -> specimen appears 3rd
Each specimen's stale result is far older than any latest.

Assertions on the exported PDF:
  - Each specimen's LATEST findings are present; every STALE finding is absent.
  - Order of appearance is Blood culture -> Sputum -> CSF (datetime order),
    NOT the insertion order (which would put CSF first).
  - Each specimen label appears exactly once (only its winner).

Throwaway clinician user + patient + microbiology rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-order-by-datetime.e2e.py
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

MARKER = f"E2EMICORD{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"MICORD.{str(int(time.time()))[-4:]}"

SPEC_BC = "Blood culture"
SPEC_SP = "Sputum"
SPEC_CS = "CSF"

BC_LATEST = f"Blood culture latest Pseudomonas {MARKER}"
BC_STALE = f"Blood culture stale contaminant {MARKER}"
SP_LATEST = f"Sputum latest Aspergillus {MARKER}"
SP_STALE = f"Sputum stale normal flora {MARKER}"
CS_LATEST = f"CSF latest Listeria {MARKER}"
CS_STALE = f"CSF stale no organisms {MARKER}"

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def at(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).isoformat()


# (specimen, findings, result_at) in the DELIBERATELY SCRAMBLED insertion order.
INSERT_SEQUENCE = [
    (SPEC_CS, CS_LATEST, at(20)),   # newest CSF, but inserted first
    (SPEC_BC, BC_STALE, at(30)),
    (SPEC_SP, SP_STALE, at(40)),
    (SPEC_CS, CS_STALE, at(50)),
    (SPEC_BC, BC_LATEST, at(1)),    # newest overall, inserted 5th
    (SPEC_SP, SP_LATEST, at(5)),    # 2nd newest, inserted last
]

# Expected render order (most recent winner first) and superseded findings.
EXPECTED_ORDER = [BC_LATEST, SP_LATEST, CS_LATEST]
STALE_FINDINGS = [BC_STALE, SP_STALE, CS_STALE]


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
            "age": 58,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "14",
            "status": "admitted",
            "admission_date": NOW.date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_microbiology(patient_id):
    # Insert one row at a time so the DB's natural row order follows the
    # scrambled insertion sequence (proving the PDF reorders by datetime).
    for specimen, findings, result_at in INSERT_SEQUENCE:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/microbiology_results",
            headers=admin_headers(),
            json={
                "patient_id": patient_id,
                "specimen_type": specimen,
                "findings": findings,
                "result_at": result_at,
            },
            timeout=30,
        )
        r.raise_for_status()
        time.sleep(0.05)  # ensure distinct created_at, mirroring the sequence


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

        assert packed(PATIENT_NAME) in packed_text, "patient missing from PDF (blank/failed export?)"

        # Winners present; stale/superseded findings absent.
        for findings in EXPECTED_ORDER:
            assert packed(findings) in packed_text, f"latest findings missing from PDF: {findings!r}"
        for findings in STALE_FINDINGS:
            assert packed(findings) not in packed_text, f"superseded findings leaked into PDF: {findings!r}"

        # Ordering strictly by datetime (BC -> SP -> CSF), NOT insertion order
        # (which inserted CSF first, Sputum last).
        positions = [packed_text.find(packed(f)) for f in EXPECTED_ORDER]
        assert all(p != -1 for p in positions), f"winner not found; positions={positions}"
        assert positions == sorted(positions), (
            "microbiology specimens are not ordered by recorded datetime "
            f"(most recent first). Expected Blood culture -> Sputum -> CSF; "
            f"positions={positions}"
        )

        # Each specimen label rendered exactly once (only its winner row).
        for spec in (SPEC_BC, SPEC_SP, SPEC_CS):
            count = packed_text.count(packed(f"{spec}:"))
            assert count == 1, f"specimen {spec!r} rendered {count} times, expected 1 (winner only)"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: microbiology 'most recent' selection and specimen ordering "
            "follow recorded datetime, independent of insertion order"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
