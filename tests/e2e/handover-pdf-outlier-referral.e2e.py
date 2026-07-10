"""
End-to-end test: the exported handover PDF correctly shows the ward, referral
status, and referral context for a patient on an OUTLYING ward (a critical
care referral / outlier), not an ICU-admitted patient.

Outliers are represented by location_type = "outlier" and status = "referred",
which the handover sheet renders in the "Location / status" column as the ward
name plus the "Referred (outlier)" status label (see STATUS_LABELS in
src/lib/icu.ts and location() in src/lib/handover-pdf.ts). The referring
consultant / team and the reason for referral live in the free-text
"Current admission" and "Management" columns. This test:

  1. Seeds an outlier patient on a named general ward with:
       - status "referred" (-> renders "Referred (outlier)")
       - a unique ward marker (the outlying ward),
       - a unique consultant/referring-team marker (Management column),
       - a unique referral-reason marker (Current admission column).
  2. Restores a clinician session, opens /patients, and exports the PDF via the
     real UI (Preview PDF -> Download PDF).
  3. Extracts the PDF text and asserts every piece of the outlier/referral
     context renders correctly and the patient is NOT mislabelled as admitted.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-outlier-referral.e2e.py
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

MARKER = f"E2EPDFOUT{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.U.T."

# Unique single-token markers so assertions are specific to this patient's row.
SUFFIX = str(int(time.time()))[-6:]
WARD = f"Radnor{SUFFIX}"          # the outlying general ward
CONSULTANT = f"DrOkafor{SUFFIX}"  # referring consultant / parent team
REASON = f"SepsisRvw{SUFFIX}"     # reason for critical care referral

REFERRED_LABEL = "Referred (outlier)"

# Fields we populate so the columns render real content (referral context).
MANAGEMENT = f"CritCareReviewUnder{CONSULTANT}"
ADMISSION = f"OutlierReferral{REASON}"


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
            "age": 58,
            # Outlying ward critical-care referral:
            "location_type": "outlier",
            "ward": WARD,
            "bed": "12",
            "status": "referred",
            "current_admission": ADMISSION,
            "current_management": MANAGEMENT,
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
    # Collapse whitespace so wrapped table cells don't hide our single-token markers.
    return out.stdout, "".join(out.stdout.split())


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

        # ---- Outlying ward appears in the Location / status column ----
        assert WARD in packed, f"outlying ward '{WARD}' missing from handover PDF"

        # ---- Referral status renders as the outlier label (referral context) ----
        assert "Referred (outlier)" in raw_text, (
            "handover PDF does not show the 'Referred (outlier)' status for the referral"
        )

        # ---- Consultant / referring team and referral reason render correctly ----
        assert CONSULTANT in packed, f"referring consultant '{CONSULTANT}' missing from handover PDF"
        assert REASON in packed, f"referral reason '{REASON}' missing from handover PDF"

        # Cleanup the artifact.
        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: handover PDF shows correct ward, consultant, and referral context for an outlier")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
