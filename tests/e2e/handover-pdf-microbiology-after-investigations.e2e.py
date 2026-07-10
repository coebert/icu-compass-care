"""
End-to-end test: in the exported handover PDF the "Key microbiology" column
heading is placed AFTER the "Most recent investigations" column heading, and
the microbiology cell renders ONLY the latest result per specimen type.

Column order in the handover table (src/lib/handover-pdf.ts) is:
  ... "Most recent investigations", "Key microbiology", "Outstanding tasks" ...
and microbiology() shows one line per specimen with the newest result
(latestMicrobiologyPerSpecimen). This test seeds a patient with MULTIPLE
microbiology results per specimen, inserted OUT OF ORDER, then drives the real
UI export and asserts against the PDF text:

  1. The "Most recent investigations" header appears before "Key microbiology".
  2. Each seeded specimen renders its NEWEST finding.
  3. Every superseded (older) microbiology finding is ABSENT.
  4. The investigations key findings still render (sanity that both columns
     coexist and are correctly separated).

Throwaway clinician user + patient (+investigations +microbiology) are created
and cleaned up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-after-investigations.e2e.py
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

MARKER = f"E2EPDFMAI{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.A.I."

SUFFIX = str(int(time.time()))[-6:]
now = datetime.now(timezone.utc)

# One key investigation so the investigations column is non-empty.
BLOODS_FIND = f"BLD{SUFFIX}"

# (finding, result_at) oldest -> newest, per specimen. Inserted out of order.
MICRO = {
    "Blood culture": [
        (f"BCOLD{SUFFIX}", now - timedelta(days=2)),
        (f"BCNEW{SUFFIX}", now - timedelta(hours=2)),
    ],
    "Urine": [
        (f"UROLD{SUFFIX}", now - timedelta(days=3)),
        (f"URNEW{SUFFIX}", now - timedelta(hours=5)),
    ],
}


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
            "age": 67,
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

        add_investigation(patient_id, "Bloods", BLOODS_FIND, iso(now - timedelta(hours=1)))
        for specimen, entries in MICRO.items():
            for finding, at in entries:
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

        # ---- 1. Microbiology header comes AFTER the investigations header ----
        assert "Most recent investigations" in raw_text, "missing investigations column header"
        assert "Key microbiology" in raw_text, "missing microbiology column header"
        inv_idx = packed.find("Mostrecentinvestigations")
        micro_idx = packed.find("Keymicrobiology")
        assert inv_idx != -1 and micro_idx != -1, "column headers not found in packed text"
        assert inv_idx < micro_idx, (
            "'Key microbiology' heading must appear AFTER 'Most recent investigations'"
        )

        # ---- 2. Each specimen shows its NEWEST finding ----
        newest = {spec: entries[-1][0] for spec, entries in MICRO.items()}
        for spec, finding in newest.items():
            assert finding in packed, f"{spec}: newest microbiology finding '{finding}' missing"

        # ---- 3. Every superseded microbiology finding is ABSENT ----
        for spec, entries in MICRO.items():
            for finding, _ in entries[:-1]:
                assert finding not in packed, (
                    f"{spec}: superseded finding '{finding}' leaked — not 'latest only'"
                )

        # ---- 4. Investigations column still renders its key finding ----
        assert f"Bloods:{BLOODS_FIND}" in packed, "Bloods key finding missing from PDF"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: microbiology header follows investigations header; only latest "
            "result per specimen is shown"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
