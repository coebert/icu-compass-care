"""
End-to-end test: the exported handover PDF shows a clear placeholder for a
patient whose DNACPR and TEP (treatment escalation plan) are NOT recorded —
never a blank cell.

The handover sheet renders a "TEP / DNACPR / NOK" column. When none of those
resuscitation/escalation flags are set, `flags()` in src/lib/handover-pdf.ts
emits the em-dash placeholder ("—") rather than an empty string. This test:

  1. Seeds a patient with EVERY other column populated with a unique marker,
     but with dnacpr_decision = false, tep_in_place = false and no NOK.
  2. Restores a clinician session, opens /patients, and exports the PDF via the
     real UI (Preview PDF -> Download PDF).
  3. Extracts the PDF text and asserts:
       - the "TEP / DNACPR / NOK" column header is present,
       - the em-dash placeholder "—" is present (the not-recorded flags cell),
       - all the OTHER seeded field markers are present (so those columns render
         real content — proving "—" is specifically the unrecorded flags cell,
         not a global rendering failure),
       - no recorded-form "DNACPR:" / "TEP:" value text leaks in.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-dnacpr-tep-placeholder.e2e.py
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

MARKER = f"E2EPDFDNR{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.R.C."

# Unique single-token markers for every OTHER column so we can prove each one
# renders real content (and is therefore not the source of the "—" placeholder).
SUFFIX = str(int(time.time()))[-6:]
PMH = f"PMH{SUFFIX}"
ADMISSION = f"ADM{SUFFIX}"
MANAGEMENT = f"MGMT{SUFFIX}"
TASKS = f"TASK{SUFFIX}"
WARD = f"Ward{SUFFIX}"

PLACEHOLDER = "\u2014"  # em-dash "—"


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
            "ward": WARD,
            "bed": "4",
            "status": "admitted",
            "past_medical_history": PMH,
            "current_admission": ADMISSION,
            "current_management": MANAGEMENT,
            "outstanding_tasks": TASKS,
            # DNACPR + TEP explicitly NOT recorded, and no next-of-kin.
            "dnacpr_decision": False,
            "tep_in_place": False,
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

        # ---- The resus/escalation column header is present ----
        assert "TEP / DNACPR / NOK" in raw_text, (
            "handover PDF missing 'TEP / DNACPR / NOK' column header"
        )

        # ---- Every OTHER column rendered real content (not placeholders) ----
        for label, value in (
            ("past medical history", PMH),
            ("current admission", ADMISSION),
            ("management", MANAGEMENT),
            ("outstanding tasks", TASKS),
            ("ward/location", WARD),
        ):
            assert value in packed, f"seeded {label} marker '{value}' missing from handover PDF"

        # ---- The not-recorded DNACPR/TEP cell shows a clear placeholder ----
        assert PLACEHOLDER in raw_text, (
            "handover PDF shows no em-dash placeholder for the not-recorded "
            "DNACPR/TEP flags — field appears blank instead of a clear placeholder"
        )

        # ---- No recorded-form DNACPR/TEP value text leaked in ----
        assert "DNACPR:" not in raw_text, "recorded-form 'DNACPR:' text leaked for a not-recorded patient"
        assert "TEP:" not in raw_text, "recorded-form 'TEP:' text leaked for a not-recorded patient"

        # Cleanup the artifact.
        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: handover PDF shows a clear placeholder for not-recorded DNACPR/TEP")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
