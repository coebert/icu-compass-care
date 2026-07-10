"""
End-to-end test: when a patient has NO TEP, NO DNACPR (and no NOK) recorded,
the handover PDF's "TEP / DNACPR / NOK" escalation column renders the em-dash
placeholder — with no stray "TEP" / "DNACPR" labels leaking in.

The flags() renderer (src/lib/handover-pdf.ts) only pushes a DNACPR line when
p.dnacpr_decision is set, a TEP line when p.tep_in_place is set, and a NOK line
when p.nok_name is set; when none are present it returns "—". This guards that
an un-escalated patient shows a clean placeholder rather than empty labels or
stale values.

Steps:
  1. Seed one patient with tep_in_place=false, dnacpr_decision=false, no NOK.
  2. Sign in, export + download the handover PDF from the real UI.
  3. Assert the escalation column header is present, the patient's escalation
     cell shows the em-dash placeholder, and no "DNACPR:" / "TEP:" detail
     fragments render for this patient.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-tep-dnacpr-unset-placeholder.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
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

MARKER = f"E2EPDFNOESC{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"NOESC{MARKER}"  # unique so the row is isolatable on the shared board

PLACEHOLDER = "\u2014"  # em-dash "—"


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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "5",
            "status": "admitted",
            # Deliberately un-escalated: no TEP, no DNACPR, no NOK.
            "tep_in_place": False,
            "dnacpr_decision": False,
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


def cleanup(patient_id, user_id):
    if patient_id:
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

            export_dialog = page.get_by_role("dialog")
            download_btn = export_dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # ---- Escalation/resus column header present ----
        assert "TEP/DNACPR/NOK" in packed_text, (
            "handover PDF missing 'TEP / DNACPR / NOK' column header"
        )

        # ---- The un-escalated patient renders in the sheet ----
        name_packed = packed(PATIENT_NAME)
        idx = packed_text.find(name_packed)
        assert idx != -1, "patient missing from handover PDF"

        # Scope to this patient's row: from the (unique) name up to a window that
        # covers the row's cells (identity | location | flags | investigations | micro)
        # before the next patient begins. The board is multi-patient, so global
        # checks would wrongly trip on other patients' real TEP/DNACPR values.
        row = packed_text[idx: idx + 140]

        # ---- The escalation cell shows the em-dash placeholder, not values ----
        assert PLACEHOLDER in row, (
            f"empty escalation cell should render an em-dash placeholder; row: {row!r}"
        )

        # ---- No escalation detail fragments for this un-escalated patient ----
        assert "DNACPR:" not in row, (
            f"an un-escalated patient must not render a 'DNACPR:' detail line; row: {row!r}"
        )
        assert "TEP:" not in row, (
            f"an un-escalated patient must not render a 'TEP:' detail line; row: {row!r}"
        )
        # No bare escalation labels either (the only 'DNACPR'/'TEP' text is the header).
        assert "DNACPR" not in row, f"stray 'DNACPR' label leaked into row: {row!r}"
        assert "TEP" not in row, f"stray 'TEP' label leaked into row: {row!r}"


        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: un-escalated patient (no TEP, no DNACPR, no NOK) renders the em-dash "
            "placeholder in the escalation column with no stray labels or details"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
