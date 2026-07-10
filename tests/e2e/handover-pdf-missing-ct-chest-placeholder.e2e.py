"""
End-to-end test: the handover PDF export renders the CT chest key line with the
em-dash placeholder when a patient has NO CT chest investigation, while other
key categories (Bloods, CXR) that DO exist still render their findings — and no
stale/other value leaks into the CT chest slot.

The investigations column renders one line per key category
(RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] in
src/lib/handover-pdf.ts). A category with no matching investigation renders
"<Category>: —". This test seeds a patient with Bloods + CXR but deliberately
NO CT chest, then drives the real UI export and asserts against the PDF text:

  1. The "CT chest" heading is present.
  2. It renders as the placeholder "CT chest: —" (packed "CTchest:—").
  3. Bloods and CXR still show their own findings.
  4. No non-CT value (Bloods/CXR findings, or a stray ECG marker) is wired to
     the CT chest heading — proving nothing stale fills the empty slot.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-missing-ct-chest-placeholder.e2e.py
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

MARKER = f"E2EPDFNOCT{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.C.T."

SUFFIX = str(int(time.time()))[-6:]
BLOODS_FIND = f"BLD{SUFFIX}"
CXR_FIND = f"CXR{SUFFIX}"
# A non-key CT-ish marker that must NOT appear against the CT chest line.
ECG_FIND = f"ECG{SUFFIX}"

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
            "age": 69,
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
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # Bloods + CXR present; NO CT chest. A non-key ECG finding exists to prove
        # it never fills the CT chest placeholder.
        add_investigation(patient_id, "Bloods", BLOODS_FIND, iso(now - timedelta(hours=1)))
        add_investigation(patient_id, "CXR", CXR_FIND, iso(now - timedelta(hours=2)))
        add_investigation(patient_id, "ECG", ECG_FIND, iso(now - timedelta(hours=3)))

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

        # ---- All key headings present ----
        for label in ("Bloods", "CXR", "CT chest"):
            assert label in raw_text, f"handover PDF missing '{label}' investigation heading"

        # ---- CT chest renders the em-dash placeholder ----
        assert "CTchest:—" in packed, (
            "missing 'CT chest: —' placeholder for the absent CT chest investigation "
            f"(packed text around CT: {packed[packed.find('CTchest'):packed.find('CTchest')+40]!r})"
        )

        # ---- Present categories still show their own findings ----
        assert f"Bloods:{BLOODS_FIND}" in packed, "Bloods finding missing/misplaced in PDF"
        assert f"CXR:{CXR_FIND}" in packed, "CXR finding missing/misplaced in PDF"

        # ---- No stale value wired to the CT chest slot ----
        for stale in (BLOODS_FIND, CXR_FIND, ECG_FIND):
            assert f"CTchest:{stale}" not in packed, (
                f"stale value '{stale}' leaked into the CT chest slot"
            )
        # The non-key ECG finding must not surface in the key column at all.
        assert ECG_FIND not in packed, (
            "non-key ECG finding leaked into the key investigations column"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: missing CT chest renders 'CT chest: —' placeholder with no "
            "stale value; Bloods/CXR unaffected"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
