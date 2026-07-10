"""
End-to-end test: the exported handover PDF's "Most recent investigations"
column renders the key categories with the EXACT expected headings and in the
EXACT expected order — Bloods, then CXR, then CT chest.

The handover sheet renders one line per key category, in a fixed display order
(RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] in
src/lib/handover-pdf.ts), each as "<Category>: <findings> (<when>)". This test
seeds one result per category (with per-category unique markers), drives the
real UI export, then asserts against the extracted PDF text that:

  1. The column header "Most recent investigations" is present and appears
     before the "Key microbiology" header (column ordering intact).
  2. Each expected category heading — "Bloods:", "CXR:", "CT chest:" — is
     present exactly as written.
  3. The three headings appear in the expected order: Bloods < CXR < CT chest.
  4. Each heading is immediately paired with ITS OWN finding (no cross-wiring
     of a category label to the wrong result).

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-investigations-order-headings.e2e.py
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

MARKER = f"E2EPDFORD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.R.D."

SUFFIX = str(int(time.time()))[-6:]
BLOODS_FIND = f"BLD{SUFFIX}"
CXR_FIND = f"CXR{SUFFIX}"
CT_FIND = f"CTC{SUFFIX}"

# Expected display order of the key investigation categories (must match
# RECENT_INVESTIGATION_CATEGORIES in src/lib/handover-pdf.ts).
EXPECTED_ORDER = ["Bloods", "CXR", "CT chest"]

now = datetime.now(timezone.utc)


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
            "age": 71,
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
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": result_at,
        },
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
    # Collapse whitespace so wrapped table cells don't hide our markers.
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # One result per key category, each with its own unique marker.
        add_investigation(patient_id, "Bloods", BLOODS_FIND, iso(now - timedelta(hours=1)))
        add_investigation(patient_id, "CXR", CXR_FIND, iso(now - timedelta(hours=2)))
        add_investigation(patient_id, "CT chest", CT_FIND, iso(now - timedelta(hours=3)))

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

        # ---- Column header present, and before the microbiology column ----
        assert "Most recent investigations" in raw_text, (
            "handover PDF missing 'Most recent investigations' column header"
        )
        inv_header_idx = packed.find("Mostrecentinvestigations")
        micro_header_idx = packed.find("Keymicrobiology")
        assert inv_header_idx != -1, "packed PDF missing investigations column header"
        assert micro_header_idx != -1, "packed PDF missing microbiology column header"
        assert inv_header_idx < micro_header_idx, (
            "column ordering wrong: 'Most recent investigations' should precede 'Key microbiology'"
        )

        # ---- Each expected heading present exactly (packed, colon-terminated) ----
        packed_headings = {
            "Bloods": "Bloods:",
            "CXR": "CXR:",
            "CT chest": "CTchest:",
        }
        idxs = {}
        for cat in EXPECTED_ORDER:
            token = packed_headings[cat]
            i = packed.find(token, inv_header_idx)
            assert i != -1, f"handover PDF missing '{cat}' heading in investigations column"
            idxs[cat] = i

        # ---- Headings appear in the expected order ----
        ordered_positions = [idxs[cat] for cat in EXPECTED_ORDER]
        assert ordered_positions == sorted(ordered_positions), (
            f"investigation headings out of order: got positions {idxs}, "
            f"expected order {EXPECTED_ORDER}"
        )

        # ---- Each heading is paired with ITS OWN finding (no cross-wiring) ----
        expected_pairs = {
            "Bloods:": BLOODS_FIND,
            "CXR:": CXR_FIND,
            "CTchest:": CT_FIND,
        }
        for heading, finding in expected_pairs.items():
            pair = f"{heading}{finding}"
            assert pair in packed, (
                f"heading '{heading}' not directly paired with its finding "
                f"'{finding}' in handover PDF (labels may be mis-mapped)"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: investigations column headings render as Bloods, CXR, CT chest in order")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
