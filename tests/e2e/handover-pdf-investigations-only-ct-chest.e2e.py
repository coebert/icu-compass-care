"""
End-to-end test: the handover PDF "most recent investigations" section renders
the exact category ordering (Bloods -> CXR -> CT chest) with correct
placeholders when ONLY a CT chest result exists, and shows no stale findings.

The section is built by investigations() over RECENT_INVESTIGATION_CATEGORIES
= ["Bloods", "CXR", "CT chest"] in src/lib/handover-pdf.ts. Each category
renders one line; a category with no result renders a "<category>: —"
placeholder, and a category with results renders the newest one's findings plus
its timestamp.

Scenario: a patient has ONLY CT chest investigations (an older STALE result and
a newer LATEST result) and no Bloods / CXR at all. The exported PDF must show:
  - "Bloods: —"   placeholder (no stale/borrowed findings)
  - "CXR: —"      placeholder
  - "CT chest: <LATEST findings> (timestamp)"   newest only
in that exact top-to-bottom order.

Assertions on the exported PDF:
  - The three category labels appear in order: Bloods, then CXR, then CT chest.
  - Bloods and CXR are rendered as em-dash placeholders with no findings text.
  - CT chest LATEST findings present; the older STALE CT chest findings absent.
  - CT chest carries a timestamp; the placeholders carry none.

Throwaway clinician user + patient + investigation rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-investigations-only-ct-chest.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
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

MARKER = f"E2ECTONLY{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"CTONLY.{str(int(time.time()))[-4:]}"

CAT_BLOODS = "Bloods"
CAT_CXR = "CXR"
CAT_CT = "CT chest"

CT_LATEST = f"CT chest latest bilateral consolidation {MARKER}"
CT_STALE = f"CT chest stale clear lung fields {MARKER}"

NOW = datetime.now(timezone.utc).replace(microsecond=0)
CT_LATEST_AT = (NOW - timedelta(hours=2)).isoformat()
CT_STALE_AT = (NOW - timedelta(days=3)).isoformat()

INVESTIGATIONS = [
    {"category": CAT_CT, "findings": CT_STALE, "result_at": CT_STALE_AT},
    {"category": CAT_CT, "findings": CT_LATEST, "result_at": CT_LATEST_AT},
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
            "age": 61,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "15",
            "status": "admitted",
            "admission_date": NOW.date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_investigations(patient_id):
    rows = [{**i, "patient_id": patient_id} for i in INVESTIGATIONS]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
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
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_investigations(patient_id)
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

        # Exact top-to-bottom category order: Bloods -> CXR -> CT chest.
        pos_bloods = packed_text.find(packed(f"{CAT_BLOODS}:"))
        pos_cxr = packed_text.find(packed(f"{CAT_CXR}:"))
        pos_ct = packed_text.find(packed(f"{CAT_CT}:"))
        assert pos_bloods != -1, "Bloods label missing from PDF"
        assert pos_cxr != -1, "CXR label missing from PDF"
        assert pos_ct != -1, "CT chest label missing from PDF"
        assert pos_bloods < pos_cxr < pos_ct, (
            "investigation categories out of order; expected Bloods -> CXR -> "
            f"CT chest; positions bloods={pos_bloods} cxr={pos_cxr} ct={pos_ct}"
        )

        # Bloods and CXR are em-dash placeholders (no findings text nor date).
        # Each placeholder window runs up to the next category label.
        bloods_window = raw_text[
            raw_text.find(f"{CAT_BLOODS}:"): raw_text.find(f"{CAT_CXR}:")
        ]
        cxr_window = raw_text[
            raw_text.find(f"{CAT_CXR}:"): raw_text.find(f"{CAT_CT}:")
        ]
        assert "—" in bloods_window, f"Bloods placeholder em-dash missing; window={bloods_window!r}"
        assert "—" in cxr_window, f"CXR placeholder em-dash missing; window={cxr_window!r}"
        assert not re.search(r"\(\d{2}/\d{2}/\d{4}", bloods_window), (
            f"Bloods placeholder unexpectedly carries a timestamp; window={bloods_window!r}"
        )
        assert not re.search(r"\(\d{2}/\d{2}/\d{4}", cxr_window), (
            f"CXR placeholder unexpectedly carries a timestamp; window={cxr_window!r}"
        )

        # CT chest shows only the LATEST findings, with a timestamp.
        assert packed(CT_LATEST) in packed_text, "CT chest latest findings missing from PDF"
        assert packed(CT_STALE) not in packed_text, "stale CT chest findings leaked into PDF"
        ct_window = packed_text[pos_ct: pos_ct + 200]
        assert packed(CT_LATEST) in ct_window, (
            f"CT chest line does not carry its latest findings; window={ct_window!r}"
        )
        assert packed((NOW - timedelta(hours=2)).strftime("%d/%m/%Y")) in ct_window, (
            f"CT chest line missing its timestamp; window={ct_window!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: investigations section renders Bloods -> CXR -> CT chest with "
            "correct placeholders, CT chest latest only, and no stale findings"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
