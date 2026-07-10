"""
Regression test: EDITING an existing TEP and DNACPR entry through the real UI
is reflected in the exported handover PDF, which must show ONLY the updated
details — the pre-edit TEP/DNACPR text must not leak anywhere.

The flags() renderer (src/lib/handover-pdf.ts) emits "DNACPR: <details>" then
"TEP: <details>" when both are set. This test guards against stale values
surviving an edit into the exported sheet.

Steps:
  1. Seed a patient that ALREADY has TEP + DNACPR recorded (old details).
  2. Open the patient detail page, click Edit, and in the "Escalation &
     resuscitation" section overwrite both the TEP details and the DNACPR
     details with new values, then Save.
  3. Confirm the DB stored the new details (and dropped the old ones).
  4. Export + download the handover PDF via the real UI.
  5. Assert the PDF shows "DNACPR: <new>" and "TEP: <new>" and that NEITHER
     old value appears anywhere in the document.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-edit-tep-dnacpr-latest.e2e.py
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

MARKER = f"E2EPDFEDTUI{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.T.D."

SUFFIX = str(int(time.time()))[-6:]
DNACPR_OLD = f"DNRold{SUFFIX}"
DNACPR_NEW = f"DNRnew{SUFFIX}"
TEP_OLD = f"TEPold{SUFFIX}"
TEP_NEW = f"TEPnew{SUFFIX}"


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
            "age": 70,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "4",
            "status": "admitted",
            # Pre-existing TEP + DNACPR entry that the UI edit will replace.
            "tep_in_place": True,
            "tep_details": TEP_OLD,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_OLD,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_flags(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details,dnacpr_decision,dnacpr_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


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

            # ---- Open the patient detail page and edit existing TEP/DNACPR ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=10000)

            # Both toggles already on; details fields are visible with old values.
            tep_details = dialog.locator(
                "div.space-y-1\\.5:has(> label:text-is('TEP details')) textarea"
            )
            expect(tep_details).to_be_visible(timeout=10000)
            expect(tep_details).to_have_value(TEP_OLD, timeout=10000)
            tep_details.fill(TEP_NEW)

            dnacpr_details = dialog.locator(
                "div.space-y-1\\.5:has(> label:text-is('DNACPR details')) input"
            )
            expect(dnacpr_details).to_be_visible(timeout=10000)
            expect(dnacpr_details).to_have_value(DNACPR_OLD)
            dnacpr_details.fill(DNACPR_NEW)

            dialog.get_by_role("button", name="Save changes").click()
            expect(dialog).to_be_hidden(timeout=15000)

            # ---- Verify only new details persisted server-side ----
            saved = read_flags(patient_id)
            assert saved["tep_in_place"] is True, f"TEP toggle lost: {saved}"
            assert saved["dnacpr_decision"] is True, f"DNACPR toggle lost: {saved}"
            assert saved["tep_details"] == TEP_NEW, f"TEP details not updated: {saved}"
            assert saved["dnacpr_details"] == DNACPR_NEW, f"DNACPR details not updated: {saved}"

            # ---- Export the handover PDF ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
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

        # ---- Only the UPDATED details render ----
        assert f"DNACPR:{DNACPR_NEW}" in packed_text, (
            f"handover PDF missing updated DNACPR value 'DNACPR: {DNACPR_NEW}'"
        )
        assert f"TEP:{TEP_NEW}" in packed_text, (
            f"handover PDF missing updated TEP value 'TEP: {TEP_NEW}'"
        )

        # ---- Pre-edit details must not leak anywhere ----
        assert DNACPR_OLD not in packed_text, (
            f"stale DNACPR details '{DNACPR_OLD}' leaked into exported PDF"
        )
        assert TEP_OLD not in packed_text, (
            f"stale TEP details '{TEP_OLD}' leaked into exported PDF"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: editing existing TEP + DNACPR via the UI updates the exported PDF to "
            "the new details only; pre-edit values do not leak"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
