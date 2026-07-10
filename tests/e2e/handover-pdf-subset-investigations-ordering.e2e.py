"""
End-to-end test: the exported handover PDF preserves EXACT section ordering even
when only a SUBSET of investigations exists — headings stay in their expected
slots, missing categories render the '—' placeholder in the correct order, and
no stale findings appear.

Two orderings are asserted:

  A) Column headers (src/lib/handover-pdf.ts autoTable head), in order:
       Most recent investigations -> Key microbiology -> Outstanding tasks
       -> TEP / DNACPR / NOK

  B) Inside the "Most recent investigations" cell, the categories always render
     in RECENT_INVESTIGATION_CATEGORIES order:
       Bloods -> CXR -> CT chest
     regardless of which ones actually have data. Missing ones show "<cat>: —".

This test seeds ONLY a CXR investigation (Bloods and CT chest absent) plus one
microbiology specimen, drives the real UI export, and asserts:

  1. Column headers appear in the exact order above.
  2. The investigations cell renders 'Bloods: —', then the CXR finding+stamp,
     then 'CT chest: —' — in that positional order.
  3. The CXR finding+timestamp is present and correctly formatted.
  4. No stale/other-category findings leak into the investigations cell (the
     absent categories show only the placeholder, never a value).

Browser timezone is pinned (Europe/London) for deterministic timestamps.
Throwaway clinician user + patient (+investigations +microbiology) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-subset-investigations-ordering.e2e.py
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

MARKER = f"E2EPDFSUB{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "S.U.B."

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(hour, minute):
    local = datetime(_day.year, _day.month, _day.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


# Only CXR present; Bloods and CT chest deliberately absent.
CXR_FIND = f"CXR{SUFFIX}"
CXR_AT = at_local(10, 45)

# One microbiology specimen so the microbiology column is non-empty.
MICRO_SPECIMEN = "Urine"
MICRO_FIND = f"URN{SUFFIX}"
MICRO_AT = at_local(11, 30)


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
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
            "age": 59,
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


def assert_order(packed_text, labels, context):
    """Assert the given packed substrings appear in strictly increasing order."""
    last = -1
    for label in labels:
        idx = packed_text.find(label)
        assert idx != -1, f"{context}: expected substring '{label}' not found in PDF"
        assert idx > last, (
            f"{context}: '{label}' appears out of order "
            f"(index {idx} not after previous {last}); expected order {labels}"
        )
        last = idx


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # Only CXR (Bloods + CT chest absent) and one microbiology specimen.
        add_investigation(patient_id, "CXR", CXR_FIND, iso(CXR_AT))
        add_microbiology(patient_id, MICRO_SPECIMEN, MICRO_FIND, iso(MICRO_AT))

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

        # ---- A. Column header ordering ----
        assert_order(
            packed_text,
            [
                "Mostrecentinvestigations",
                "Keymicrobiology",
                "Outstandingtasks",
                "TEP/DNACPR/NOK",
            ],
            "column headers",
        )

        # ---- B. Investigations cell category ordering (Bloods -> CXR -> CT chest) ----
        cxr_stamp = fmt_datetime_engb(CXR_AT)
        assert_order(
            packed_text,
            [
                "Bloods:—",
                packed(f"CXR: {CXR_FIND} ({cxr_stamp})"),
                "CTchest:—",
            ],
            "investigations cell ordering",
        )

        # ---- 3. CXR value present & correctly formatted (already checked above) ----
        assert packed(f"CXR: {CXR_FIND} ({cxr_stamp})") in packed_text, (
            "CXR finding + formatted timestamp missing"
        )

        # ---- 4. Absent categories show ONLY the placeholder (no stale values) ----
        # There must be exactly the placeholder for Bloods and CT chest, and the
        # CXR marker must not appear glued to a wrong category slot.
        assert "Bloods:—" in packed_text, "Bloods placeholder missing"
        assert "CTchest:—" in packed_text, "CT chest placeholder missing"
        # No accidental Bloods/CT chest value: the unique CXR finding must not be
        # attributed to another category.
        assert packed(f"Bloods: {CXR_FIND}") not in packed_text, "CXR value leaked into Bloods slot"
        assert packed(f"CTchest:{CXR_FIND}") not in packed_text, "CXR value leaked into CT chest slot"

        # Microbiology column still renders its specimen (sanity).
        assert packed(f"{MICRO_SPECIMEN}: {MICRO_FIND}") in packed_text, "microbiology specimen missing"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: subset-of-investigations export keeps header + category ordering "
            "(Bloods — -> CXR value -> CT chest —) with no stale findings"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
