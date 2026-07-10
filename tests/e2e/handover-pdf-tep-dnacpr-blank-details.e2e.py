"""
End-to-end test: the handover PDF renders the escalation (TEP / DNACPR / NOK)
column CLEANLY when TEP or DNACPR is recorded but its details are left blank,
and when they are not set at all.

flags() in src/lib/handover-pdf.ts renders:
  - `DNACPR` (label only) when dnacpr_decision is set but dnacpr_details is empty
  - `DNACPR: <text>` only when details are present
  - the same shape for TEP
  - `—` when nothing (no TEP, no DNACPR, no NOK) is set

This guards two "clear rendering" cases:
  A. BLANK details — decision/plan flagged but no free text: the column shows a
     bare `DNACPR` / `TEP` label with NO dangling colon and no empty fragment.
  B. NOT SET — no TEP, no DNACPR, no NOK: the column shows the em-dash
     placeholder with no stray labels.

Both patients are exported in the same handover PDF and each row is checked in
isolation (scoped to the patient's unique name) so other patients on the board
cannot cause false positives/negatives.

Throwaway clinician user + patients are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-tep-dnacpr-blank-details.e2e.py
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

MARKER = f"TDBLANK{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
N = str(int(time.time()))[-4:]
BLANK_NAME = f"BK.{N}"    # TEP + DNACPR flagged, details blank
UNSET_NAME = f"UN.{N}"    # nothing escalation-related set

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


def create_patient(fields):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "5",
            "status": "admitted",
            **fields,
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
        if pid:
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


def row_window(packed_text, name, width=140):
    idx = packed_text.find(packed(name))
    assert idx != -1, f"patient '{name}' missing from handover PDF"
    return packed_text[idx: idx + width]


def main():
    user_id = None
    blank_id = unset_id = None
    try:
        user_id, email = create_user()
        # A: decision/plan flagged, but details intentionally left blank.
        blank_id = create_patient({
            "full_name": BLANK_NAME,
            "dnacpr_decision": True,
            "dnacpr_details": "",
            "tep_in_place": True,
            "tep_details": "",
        })
        # B: nothing escalation-related set.
        unset_id = create_patient({
            "full_name": UNSET_NAME,
            "dnacpr_decision": False,
            "tep_in_place": False,
        })
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
            expect(page.get_by_text(BLANK_NAME, exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_text(UNSET_NAME, exact=False).first).to_be_visible(timeout=15000)

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

        assert "TEP/DNACPR/NOK" in packed_text, (
            "handover PDF missing 'TEP / DNACPR / NOK' column header"
        )

        # ---- A. BLANK details: bare labels, no dangling colon/empty fragment ----
        blank_row = row_window(packed_text, BLANK_NAME)
        assert "DNACPR" in blank_row, f"flagged DNACPR label missing; row: {blank_row!r}"
        assert "TEP" in blank_row, f"flagged TEP label missing; row: {blank_row!r}"
        assert "DNACPR:" not in blank_row, (
            f"blank DNACPR details must not render a dangling 'DNACPR:'; row: {blank_row!r}"
        )
        assert "TEP:" not in blank_row, (
            f"blank TEP details must not render a dangling 'TEP:'; row: {blank_row!r}"
        )

        # ---- B. NOT SET: em-dash placeholder, no stray labels ----
        unset_row = row_window(packed_text, UNSET_NAME)
        assert PLACEHOLDER in unset_row, (
            f"un-escalated patient should render em-dash placeholder; row: {unset_row!r}"
        )
        assert "DNACPR" not in unset_row, f"stray 'DNACPR' leaked into unset row: {unset_row!r}"
        assert "TEP" not in unset_row, f"stray 'TEP' leaked into unset row: {unset_row!r}"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: PDF renders cleanly for blank TEP/DNACPR details (bare labels, no "
            "dangling colon) and for the not-set case (em-dash placeholder)"
        )
        return 0
    finally:
        cleanup([blank_id, unset_id], user_id)


if __name__ == "__main__":
    sys.exit(main())
