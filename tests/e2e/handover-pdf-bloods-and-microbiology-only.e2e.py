"""
End-to-end test: the handover PDF sections stay in their expected positions
when only Bloods (investigations) and microbiology are present — no CXR and no
CT chest results at all.

The "most recent investigations" column is built by investigations() over
RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] in
src/lib/handover-pdf.ts. Each category renders one line; a category with no
result renders a "<category>: —" placeholder. The "key microbiology" column is
built separately by microbiology(), newest per specimen, most recent first.

Scenario: a patient has Bloods investigations (older STALE + newer LATEST) and
two microbiology specimens, but NO CXR and NO CT chest. The exported PDF must:
  - investigations: "Bloods: <LATEST> (timestamp)" then "CXR: —" then
    "CT chest: —" — in that exact order, placeholders holding their cells.
  - microbiology: each specimen's newest findings present.
  - no stale Bloods findings surface anywhere.

Assertions on the exported PDF:
  - Category labels appear in order Bloods -> CXR -> CT chest.
  - Bloods carries its LATEST findings + a timestamp; the STALE Bloods findings
    are absent.
  - CXR and CT chest are em-dash placeholders with no findings and no timestamp.
  - Both microbiology specimens' newest findings are present.

Throwaway clinician user + patient + investigation + microbiology rows are
created and cleaned up via the Supabase admin REST API. Nothing lingers in the
clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-bloods-and-microbiology-only.e2e.py
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

MARKER = f"E2EBLDMIC{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"BLDMIC.{str(int(time.time()))[-4:]}"

CAT_BLOODS = "Bloods"
CAT_CXR = "CXR"
CAT_CT = "CT chest"

BLOODS_LATEST = f"Bloods latest CRP rising WCC 18 {MARKER}"
BLOODS_STALE = f"Bloods stale CRP normal {MARKER}"

SPEC_BC = "Blood culture"
SPEC_UR = "Urine"
BC_LATEST = f"Blood culture latest E coli {MARKER}"
BC_STALE = f"Blood culture stale no growth {MARKER}"
UR_LATEST = f"Urine latest Enterococcus {MARKER}"

NOW = datetime.now(timezone.utc).replace(microsecond=0)
BLOODS_LATEST_AT = (NOW - timedelta(hours=3)).isoformat()
BLOODS_STALE_AT = (NOW - timedelta(days=2)).isoformat()

INVESTIGATIONS = [
    {"category": CAT_BLOODS, "findings": BLOODS_STALE, "result_at": BLOODS_STALE_AT},
    {"category": CAT_BLOODS, "findings": BLOODS_LATEST, "result_at": BLOODS_LATEST_AT},
]

MICROBIOLOGY = [
    {"specimen_type": SPEC_BC, "findings": BC_STALE, "result_at": (NOW - timedelta(days=1)).isoformat()},
    {"specimen_type": SPEC_BC, "findings": BC_LATEST, "result_at": (NOW - timedelta(hours=4)).isoformat()},
    {"specimen_type": SPEC_UR, "findings": UR_LATEST, "result_at": (NOW - timedelta(hours=8)).isoformat()},
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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "16",
            "status": "admitted",
            "admission_date": NOW.date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed(patient_id):
    inv = [{**i, "patient_id": patient_id} for i in INVESTIGATIONS]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=inv,
        timeout=30,
    ).raise_for_status()
    mic = [{**m, "patient_id": patient_id} for m in MICROBIOLOGY]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=mic,
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
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed(patient_id)
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

        # Exact category order: Bloods -> CXR -> CT chest.
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

        # Bloods cell: latest findings + timestamp; stale absent.
        assert packed(BLOODS_LATEST) in packed_text, "Bloods latest findings missing from PDF"
        assert packed(BLOODS_STALE) not in packed_text, "stale Bloods findings leaked into PDF"
        bloods_window = raw_text[raw_text.find(f"{CAT_BLOODS}:"): raw_text.find(f"{CAT_CXR}:")]
        assert packed(BLOODS_LATEST) in packed(bloods_window), (
            f"Bloods cell does not carry its latest findings; window={bloods_window!r}"
        )
        assert re.search(r"\(\d{2}/\d{2}/\d{4}", bloods_window), (
            f"Bloods cell missing its timestamp; window={bloods_window!r}"
        )

        # CXR and CT chest are em-dash placeholders (no findings, no timestamp).
        cxr_window = raw_text[raw_text.find(f"{CAT_CXR}:"): raw_text.find(f"{CAT_CT}:")]
        ct_window = raw_text[raw_text.find(f"{CAT_CT}:"):]
        # Bound the CT window to its own line-ish region.
        ct_window = ct_window[:120]
        assert "—" in cxr_window, f"CXR placeholder em-dash missing; window={cxr_window!r}"
        assert "—" in ct_window, f"CT chest placeholder em-dash missing; window={ct_window!r}"
        assert not re.search(r"\(\d{2}/\d{2}/\d{4}", cxr_window), (
            f"CXR placeholder unexpectedly carries a timestamp; window={cxr_window!r}"
        )
        assert not re.search(r"\(\d{2}/\d{2}/\d{4}", ct_window), (
            f"CT chest placeholder unexpectedly carries a timestamp; window={ct_window!r}"
        )

        # Microbiology cells: newest per specimen present; stale absent.
        assert packed(BC_LATEST) in packed_text, "Blood culture latest findings missing from PDF"
        assert packed(UR_LATEST) in packed_text, "Urine latest findings missing from PDF"
        assert packed(BC_STALE) not in packed_text, "stale Blood culture findings leaked into PDF"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: with only Bloods + microbiology present, investigations render "
            "Bloods -> CXR(—) -> CT chest(—) in order, no stale findings, and "
            "microbiology specimens render correctly"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
