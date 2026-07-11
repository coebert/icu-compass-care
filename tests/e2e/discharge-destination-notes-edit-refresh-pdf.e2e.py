"""
End-to-end test: for an already-DISCHARGED patient, a clinician reloads the
record, edits the discharge destination and the clinical notes (Current
management) through the real Edit dialog, saves, and the updated values both
persist (survive a further refresh + reach the database) AND render correctly
in the generated handover PDF.

This exercises the amend-a-completed-record path (records stay editable after
discharge) plus PDF regeneration, driven entirely through the app UI.

Steps:
  1. Seed one already-discharged patient with an *initial* destination + notes.
  2. Sign in, open the patient detail page, and hard-refresh it.
  3. Open Edit, overwrite Discharge destination + Current management with NEW
     values, and Save changes.
  4. Assert the DB stored the new destination + management (old values gone).
  5. Hard-refresh again and re-open Edit — the fields still show the NEW values.
  6. On /patients, toggle Archive, export + download the handover PDF, and
     assert it shows the NEW destination ("To <dest>") and the NEW management
     text, and no longer the stale originals.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/discharge-destination-notes-edit-refresh-pdf.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
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

MARKER = f"E2EDDN{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.N.EDIT"
TODAY = datetime.now(timezone.utc).date().isoformat()

OLD_DEST = f"Old ward A {MARKER}"
OLD_MGMT = f"Old management plan {MARKER}"
NEW_DEST = f"New rehab ward B {MARKER}"
NEW_MGMT = f"Amended handover notes {MARKER}"


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
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "discharged",
            "admission_date": TODAY,
            "discharge_date": TODAY,
            "discharge_destination": OLD_DEST,
            "current_management": OLD_MGMT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_destination,current_management",
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


def open_edit_dialog(page):
    page.get_by_role("button", name="Edit").click()
    dlg = page.get_by_role("dialog")
    expect(dlg.get_by_text("Edit patient")).to_be_visible(timeout=10000)
    return dlg


def dest_input(dlg):
    return dlg.locator('div:has(> label:text-is("Discharge destination")) input')


def mgmt_textarea(dlg):
    return dlg.locator('div:has(> label:text-is("Current management")) textarea')


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

            detail_url = f"{BASE_URL}/patients/{patient_id}"
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            # ---- 1. Refresh the discharged record, then edit ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text("Discharged").first).to_be_visible(timeout=15000)

            dlg = open_edit_dialog(page)
            # Confirm we are amending the existing (old) values.
            expect(dest_input(dlg)).to_have_value(OLD_DEST, timeout=10000)
            expect(mgmt_textarea(dlg)).to_have_value(OLD_MGMT)

            dest_input(dlg).fill(NEW_DEST)
            mgmt_textarea(dlg).fill(NEW_MGMT)
            dlg.get_by_role("button", name="Save changes").click()
            page.wait_for_timeout(1500)
            page.screenshot(path=str(SCREENSHOTS / "ddn_debug_save.png"))
            page.screenshot(path=str(SCREENSHOTS / "ddn_1_after_save.png"))

            # ---- 2. DB persisted the new values ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status changed: {row['status']!r}"
            assert row["discharge_destination"] == NEW_DEST, (
                f"destination not updated: {row['discharge_destination']!r}"
            )
            assert row["current_management"] == NEW_MGMT, (
                f"management notes not updated: {row['current_management']!r}"
            )

            # ---- 3. Refresh again: values persist in the UI ----
            page.goto(detail_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            dlg = open_edit_dialog(page)
            expect(dest_input(dlg)).to_have_value(NEW_DEST, timeout=10000)
            expect(mgmt_textarea(dlg)).to_have_value(NEW_MGMT)
            page.keyboard.press("Escape")

            # ---- 4. Export the archived handover PDF and check the new values ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            page.get_by_role("button", name="Archive").click()
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            pdf_dlg = page.get_by_role("dialog")
            download_btn = pdf_dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            dl_info.value.save_as(str(pdf_path))

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        assert packed(PATIENT_NAME) in packed_text, "patient missing from PDF"
        assert "Discharged" in raw_text, "'Discharged' status not rendered in PDF"
        assert packed(f"To {NEW_DEST}") in packed_text, (
            f"updated destination not rendered as 'To {NEW_DEST}' in PDF"
        )
        assert packed(NEW_MGMT) in packed_text, "updated management notes missing from PDF"
        assert packed(OLD_DEST) not in packed_text, "stale destination still in PDF"
        assert packed(OLD_MGMT) not in packed_text, "stale management notes still in PDF"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: discharge destination + notes edited after refresh persist "
            "(DB + reload) and render correctly in the handover PDF"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
