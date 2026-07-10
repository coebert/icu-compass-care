"""
End-to-end test: creating an OUTLYING WARD REFERRAL patient through the real UI
and verifying the exported handover PDF includes that patient with the correct
outlying ward / referral details.

Unlike handover-pdf-outlier-referral.e2e.py (which seeds the outlier row via the
admin REST API), this test drives the actual "Add patient" form in the browser:
it sets Location = "Outlying ward / referral", Status = "Referred (outlier)",
fills the ward and referral context free-text, saves, then exports the handover
PDF via Preview PDF -> Download PDF and asserts the outlier context renders.

Flow:
  1. Restore a throwaway clinician session and open /patients.
  2. Click "Add patient" and fill the form as an outlier referral:
       - Location  -> Outlying ward / referral   (location_type = "outlier")
       - Status    -> Referred (outlier)          (status = "referred")
       - Ward      -> unique ward marker (the outlying ward)
       - Current admission / management -> unique referral-reason / consultant
         markers so the referral columns render real content.
  3. Save the patient and confirm it appears on the board.
  4. Export the handover PDF through the UI.
  5. Extract the PDF text and assert:
       - the outlying ward marker renders in the Location / status column,
       - the "Referred (outlier)" status label renders (not "Admitted"),
       - the referring consultant + referral reason markers render.

Throwaway clinician user is created/cleaned via the admin REST API; the patient
is created via the UI and cleaned up by its unique name at the end. Nothing
lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-outlier-referral-created-via-ui.e2e.py
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

MARKER = f"E2EOUTUI{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"

SUFFIX = str(int(time.time()))[-6:]
PATIENT_NAME = f"U.I.{SUFFIX[-2:]}"     # short initials (form maxLength=10)
WARD = f"Radnor{SUFFIX}"                # the outlying general ward
CONSULTANT = f"DrPatelUI{SUFFIX}"       # referring consultant / parent team
REASON = f"AkiRvwUI{SUFFIX}"           # reason for critical care referral

REFERRED_LABEL = "Referred (outlier)"
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


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_patient_ids():
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?full_name=eq.{urllib.parse.quote(PATIENT_NAME)}&select=id",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return [row["id"] for row in r.json()]


def cleanup(user_id):
    for pid in find_patient_ids():
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
    return out.stdout, "".join(out.stdout.split())


def fill_field(dialog, label, value):
    """Fill a text input whose <Label> text is `label` (Field renders the
    Label as a sibling of the input inside a wrapper div)."""
    inp = dialog.locator(
        f'xpath=.//label[normalize-space()="{label}"]/following-sibling::*[self::input or self::textarea][1]'
    )
    inp.first.fill(value)


def select_option(dialog, label, option_text):
    """Open a Radix Select whose trigger follows the given Label, pick option."""
    trigger = dialog.locator(
        f'xpath=.//label[normalize-space()="{label}"]/following-sibling::button[1]'
    ).first
    trigger.click()
    # Radix renders options in a portal at the document root as role=option.
    dialog.page.get_by_role("option", name=option_text, exact=True).click()


def main():
    user_id = None
    try:
        user_id, email = create_user()
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

            # ---- Open the Add patient form ----
            page.get_by_role("button", name="Add patient").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_role("heading", name="Add patient")).to_be_visible(timeout=10000)

            # ---- Fill it as an outlying ward referral ----
            fill_field(dialog, "Initials *", PATIENT_NAME)
            fill_field(dialog, "Age *", "63")
            select_option(dialog, "Location", "Outlying ward / referral")
            select_option(dialog, "Status", REFERRED_LABEL)
            fill_field(dialog, "Ward", WARD)
            fill_field(dialog, "Bed", "9")
            fill_field(dialog, "Current admission", ADMISSION)
            fill_field(dialog, "Current management", MANAGEMENT)

            page.screenshot(path=str(SCREENSHOTS / f"{MARKER}_form.png"))

            dialog.get_by_role("button", name="Add patient").click()

            # Dialog closes and the patient appears on the board.
            expect(dialog.get_by_role("heading", name="Add patient")).to_be_hidden(timeout=10000)
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- Export the handover PDF via the UI ----
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

        raw_text, packed = extract_pdf_text(pdf_path)

        # ---- The patient is present in the exported PDF ----
        assert "".join(PATIENT_NAME.split()) in packed, (
            f"patient '{PATIENT_NAME}' missing from handover PDF"
        )

        # ---- Outlying ward renders in the Location / status column ----
        assert WARD in packed, f"outlying ward '{WARD}' missing from handover PDF"

        # ---- Referral status renders as the outlier label (not admitted) ----
        assert REFERRED_LABEL in raw_text, (
            "handover PDF does not show the 'Referred (outlier)' status for the referral"
        )

        # ---- Referring consultant + referral reason render correctly ----
        assert CONSULTANT in packed, f"referring consultant '{CONSULTANT}' missing from handover PDF"
        assert REASON in packed, f"referral reason '{REASON}' missing from handover PDF"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: outlier referral created via UI renders correctly in the handover PDF")
        return 0
    finally:
        cleanup(user_id)


if __name__ == "__main__":
    sys.exit(main())
