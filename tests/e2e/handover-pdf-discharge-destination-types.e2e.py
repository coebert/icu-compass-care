"""
End-to-end test: specific discharge destination TYPES (ward, theatre,
step-down) each render correctly in the exported handover PDF.

Where handover-pdf-discharge-destination.e2e.py exercises the *act* of
discharging through the Status tab, and handover-pdf-discharged-patient-retained
covers retention of a single discharged record, THIS test focuses on the
fidelity of the destination string itself across several realistic
destination types. Each seeded patient carries a distinct, human-meaningful
discharge destination (a ward, theatre recovery, and a step-down unit), and
the export must render each verbatim as "To <destination>" against the
correct patient — with no destination bleeding into another patient's row.

The handover sheet's "Location / status" column is built by location() in
src/lib/handover-pdf.ts. For a discharged patient it renders:

  <ward · Bed n>
  Discharged
  To <discharge_destination>
  Adm <dd/mm/yyyy>

Discharged patients live in the archived list, so the export is taken with
"Archive" toggled on.

Steps:
  1. Seed three patients already discharged, each with a different destination
     type, on distinct beds (so the bed board does not collapse them).
  2. Sign in, go to /patients, toggle Archive so discharged records show.
  3. Export + download the handover PDF.
  4. For each patient, assert the PDF shows the name, "Discharged", and the
     exact "To <destination>" within that patient's row window.

Throwaway clinician user + patients are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-discharge-destination-types.e2e.py
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

MARKER = f"E2EPDFDDT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

DISCHARGE_DATE = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=9)).isoformat()

# Three destination TYPES, each with a distinct patient + bed.
CASES = [
    {
        "name": f"DDT.WARD.{str(int(time.time()))[-4:]}",
        "bed": "21",
        "dest": f"Radnor Ward {MARKER}",
        "label": "ward",
    },
    {
        "name": f"DDT.THTR.{str(int(time.time()))[-4:]}",
        "bed": "22",
        "dest": f"Theatre recovery {MARKER}",
        "label": "theatre",
    },
    {
        "name": f"DDT.STEP.{str(int(time.time()))[-4:]}",
        "bed": "23",
        "dest": f"Step-down HDU {MARKER}",
        "label": "step-down",
    },
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


def create_discharged_patient(case):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": case["name"],
            "age": 70,
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

            # Discharged records live in the archive view.
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

        raw_text, packed_text = extract_pdf_text(pdf_path)

        assert "Discharged" in raw_text, "'Discharged' status not rendered in PDF"

        for case in CASES:
            name_packed = packed(case["name"])
            assert name_packed in packed_text, (
                f"[{case['label']}] discharged patient {case['name']!r} "
                "missing from the exported PDF"
            )
            # Scope the destination assertion to this patient's row window so a
            # destination cannot satisfy the check from another patient's row.
            start = packed_text.find(name_packed)
            window = packed_text[start:start + 200]
            assert packed(f"To {case['dest']}") in window, (
                f"[{case['label']}] destination not rendered as "
                f"'To {case['dest']}' in {case['name']}'s row; "
                f"window: {window!r}"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: ward, theatre and step-down discharge destinations each "
            "render as 'To <destination>' against the correct patient in the "
            "archived handover PDF"
        )
        return 0
    finally:
        cleanup(patient_ids, user_id)


if __name__ == "__main__":
    sys.exit(main())
