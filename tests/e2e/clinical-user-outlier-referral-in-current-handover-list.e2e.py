"""
End-to-end test: a signed-in CLINICAL user creates a patient on an OUTLYING
WARD (referred to critical care) through the real "Add patient" form, and that
patient shows up in the APPROPRIATE handover list — the CURRENT / active
handover — and NOT in the archived (discharged & deceased) handover.

The Patient board (src/routes/_authenticated/patients.index.tsx) splits into a
"current" view (status admitted or referred) and an "Archive" view (discharged
/ died). The handover preview built from each view therefore has two audiences.
A referred outlier is an ACTIVE patient, so it belongs on the current handover
list only.

Flow:
  1. Restore a throwaway clinician session and open /patients.
  2. Add patient as an outlying ward referral:
       - Location  -> Outlying ward / referral   (location_type = "outlier")
       - Status    -> Referred (outlier)          (status = "referred")
       - Ward / Hospital number / Current admission -> unique markers so the
         record renders real content and passes the export critical-field guard.
  3. Confirm the patient appears on the current board.
  4. Filter the board to just this patient (by hospital number), open
     Preview PDF, download the CURRENT handover, and assert the outlier patient
     renders with its ward and the "Referred (outlier)" status.
  5. Switch to the Archive view and confirm the patient is ABSENT there — it is
     active, so it must not appear in the archived handover list.

Throwaway clinician user is created/cleaned via the admin REST API; the patient
is created via the UI and cleaned up by its unique name at the end. Nothing
lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/clinical-user-outlier-referral-in-current-handover-list.e2e.py
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

MARKER = f"E2EOUTLIST{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"

SUFFIX = str(int(time.time()))[-6:]
PATIENT_NAME = f"O.L.{SUFFIX[-2:]}"      # short initials (form maxLength=10)
HOSPITAL_NUMBER = f"MRN{SUFFIX}"
WARD = f"Radnor{SUFFIX}"                  # the outlying general ward
CONSULTANT = f"DrPatel{SUFFIX}"          # referring consultant / parent team
REASON = f"AkiRvw{SUFFIX}"               # reason for critical care referral

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
    inp = dialog.locator(
        f'xpath=.//label[normalize-space()="{label}"]/following-sibling::*[self::input or self::textarea][1]'
    )
    inp.first.fill(value)


def select_option(dialog, label, option_text):
    trigger = dialog.locator(
        f'xpath=.//label[normalize-space()="{label}"]/following-sibling::button[1]'
    ).first
    trigger.click()
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
            assert "/auth" not in page.url, f"redirected to /auth: {page.url}"

            # ---- Create the outlying ward referral via the Add patient form ----
            page.get_by_role("button", name="Add patient").click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_role("heading", name="Add patient")).to_be_visible(
                timeout=10000
            )
            fill_field(dialog, "Initials *", PATIENT_NAME)
            fill_field(dialog, "Age *", "63")
            fill_field(dialog, "Hospital number", HOSPITAL_NUMBER)
            select_option(dialog, "Location", "Outlying ward / referral")
            select_option(dialog, "Status", REFERRED_LABEL)
            fill_field(dialog, "Ward", WARD)
            fill_field(dialog, "Bed", "9")
            fill_field(dialog, "Current admission", ADMISSION)
            fill_field(dialog, "Current management", MANAGEMENT)
            dialog.get_by_role("button", name="Add patient").click()
            expect(dialog.get_by_role("heading", name="Add patient")).to_be_hidden(
                timeout=10000
            )
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- Filter the current board to just this patient, export the
            #      CURRENT handover, and assert the outlier appears in it ----
            page.get_by_placeholder("Search initials or hospital no.…").fill(
                HOSPITAL_NUMBER
            )
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=10000
            )

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
            # Close the export dialog.
            page.keyboard.press("Escape")
            expect(export_dialog.get_by_role("button", name="Download PDF")).to_have_count(
                0, timeout=10000
            )

            # ---- Switch to the Archive view: the active outlier must be ABSENT ----
            page.get_by_placeholder("Search initials or hospital no.…").fill("")
            page.get_by_role("button", name="Archive").click()
            expect(
                page.get_by_role("button", name="Show current")
            ).to_be_visible(timeout=10000)
            page.get_by_placeholder("Search initials or hospital no.…").fill(
                HOSPITAL_NUMBER
            )
            page.wait_for_timeout(800)
            assert page.get_by_text(PATIENT_NAME, exact=False).count() == 0, (
                "active referred outlier wrongly appears in the archived handover list"
            )

            browser.close()

        raw_text, packed = extract_pdf_text(pdf_path)

        # The outlier patient is present in the CURRENT handover, with its
        # outlying ward and the referral status label (not "Admitted").
        assert "".join(PATIENT_NAME.split()) in packed, (
            f"patient '{PATIENT_NAME}' missing from current handover list"
        )
        assert WARD in packed, f"outlying ward '{WARD}' missing from current handover"
        assert REFERRED_LABEL in raw_text, (
            "current handover does not show the 'Referred (outlier)' status"
        )
        assert CONSULTANT in packed, (
            f"referring consultant '{CONSULTANT}' missing from current handover"
        )
        assert REASON in packed, (
            f"referral reason '{REASON}' missing from current handover"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: outlying ward referral created via UI appears in the CURRENT "
            "handover list (with ward + 'Referred (outlier)' status) and is "
            "absent from the archived handover list"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback; traceback.print_exc()
        try:
            page.screenshot(path=str(SCREENSHOTS / f"DEBUG_{MARKER}.png"))
        except Exception:
            pass
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(user_id)


if __name__ == "__main__":
    sys.exit(main())
