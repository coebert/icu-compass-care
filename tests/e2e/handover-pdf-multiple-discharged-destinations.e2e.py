"""
End-to-end test: an exported handover PDF containing MULTIPLE discharged
patients renders each patient's own discharge destination AND status correctly,
with strict per-row isolation (no destination or status bleeds between rows).

This complements handover-pdf-discharge-destination-types.e2e.py by adding:
  * a fourth discharged patient with NO destination — must still render the
    "Discharged" status but MUST NOT render a spurious "To ..." line, and
  * an explicit per-row check that every OTHER patient's destination does NOT
    appear inside a given patient's row window (cross-bleed guard).

The handover sheet's "Location / status" column (location() in
src/lib/handover-pdf.ts) renders for a discharged patient:

  <ward · Bed n>
  Discharged
  To <discharge_destination>   (only when a destination is set)
  Adm <dd/mm/yyyy>

Discharged records live in the archive view, so the export is taken with
"Archive" toggled on.

Steps:
  1. Seed four discharged patients on distinct beds: three with distinct
     destinations, one with no destination.
  2. Sign in, open /patients, toggle Archive.
  3. Export + download the handover PDF.
  4. For each patient assert, within its own row window: name present,
     "Discharged" status present, own destination present (or absent for the
     blank one), and NO other patient's destination present.

Throwaway clinician user + patients are created/cleaned via the admin REST API.
Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-multiple-discharged-destinations.e2e.py
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

MARKER = f"E2EMDD{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
STAMP = str(int(time.time()))[-5:]

DISCHARGE_DATE = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=9)).isoformat()

# Four discharged patients on distinct beds; the last has no destination.
CASES = [
    {"name": f"MDD.WARD.{STAMP}", "bed": "31", "dest": f"Radnor Ward {MARKER}"},
    {"name": f"MDD.THTR.{STAMP}", "bed": "32", "dest": f"Theatre Recovery {MARKER}"},
    {"name": f"MDD.STEP.{STAMP}", "bed": "33", "dest": f"StepDown HDU {MARKER}"},
    {"name": f"MDD.NONE.{STAMP}", "bed": "34", "dest": ""},  # no destination
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
    body = {
        "full_name": case["name"],
        "age": 71,
        "location_type": "icu",
        "ward": "Critical Care",
        "bed": case["bed"],
        "status": "discharged",
        "admission_date": ADMISSION_DATE,
        "discharge_date": DISCHARGE_DATE,
    }
    if case["dest"]:
        body["discharge_destination"] = case["dest"]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=body,
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

        # Positions of every seeded patient name so each row window can be bounded
        # by the NEXT patient's name (rows are compact; a fixed width overruns).
        positions = sorted(packed_text.find(packed(c["name"])) for c in CASES)

        for case in CASES:
            name_packed = packed(case["name"])
            assert name_packed in packed_text, (
                f"discharged patient {case['name']!r} missing from the exported PDF"
            )
            start = packed_text.find(name_packed)
            nexts = [pos for pos in positions if pos > start]
            end = min(nexts) if nexts else start + 220
            window = packed_text[start:end]

            # ---- Status renders as Discharged in this patient's row ----
            assert "Discharged" in window, (
                f"{case['name']}'s row does not show 'Discharged' status; window: {window!r}"
            )

            # ---- Own destination present (or absent for the blank case) ----
            if case["dest"]:
                assert packed(f"To {case['dest']}") in window, (
                    f"{case['name']}'s row missing 'To {case['dest']}'; window: {window!r}"
                )
            else:
                assert "To" not in window.replace("Adm", ""), (
                    f"{case['name']} has no destination but a 'To ...' line rendered; "
                    f"window: {window!r}"
                )

            # ---- No OTHER patient's destination bleeds into this row ----
            for other in CASES:
                if other is case or not other["dest"]:
                    continue
                assert packed(f"To {other['dest']}") not in window, (
                    f"{other['name']}'s destination leaked into {case['name']}'s row; "
                    f"window: {window!r}"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: multiple discharged patients each render their own discharge "
            "destination and 'Discharged' status with no cross-row bleed"
        )
        return 0
    finally:
        cleanup(patient_ids, user_id)


if __name__ == "__main__":
    sys.exit(main())
