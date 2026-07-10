"""
End-to-end test: editing an investigation's collection date to a newer time
updates the exported handover PDF's "most recent per category" section.

The handover sheet renders the newest finding per category by result_at (see
mostRecentInvestigation / RECENT_INVESTIGATION_CATEGORIES in
src/lib/handover-pdf.ts). This test proves that CHANGING an existing entry's
collection date re-selects which finding is "most recent":

  1. Seed a patient with two Bloods results:
       - ENTRY_A: findings "BLOODA…", collection date 3 days ago (older)
       - ENTRY_B: findings "BLOODB…", collection date 1 hour ago (newest)
  2. Export the PDF via the real UI and confirm it shows ENTRY_B (the newest).
  3. EDIT ENTRY_A's collection date to be newer than ENTRY_B.
  4. Re-export the PDF and confirm it now shows ENTRY_A and no longer ENTRY_B.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/investigation-edit-newest-pdf.e2e.py
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

MARKER = f"E2EINVEDIT{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.D.T."

SUFFIX = str(int(time.time()))[-6:]
BLOOD_A = f"BLOODA{SUFFIX}"   # starts older, later edited to be newest
BLOOD_B = f"BLOODB{SUFFIX}"   # starts newest

now = datetime.now(timezone.utc)


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
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_investigation(patient_id, category, findings, result_at):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def edit_collection_date(investigation_id, result_at):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/investigations?id=eq.{investigation_id}",
        headers=admin_headers(),
        json={"result_at": result_at},
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
    return "".join(out.stdout.split())


def export_pdf(page, tag):
    """Drive the real UI export and return the packed PDF text."""
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
    pdf_path = SCREENSHOTS / f"handover_{MARKER}_{tag}.pdf"
    download.save_as(str(pdf_path))
    assert download.suggested_filename.lower().endswith(".pdf")

    # Close the dialog before the next export.
    page.keyboard.press("Escape")

    packed = extract_pdf_text(pdf_path)
    try:
        pdf_path.unlink()
    except OSError:
        pass
    return packed


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        entry_a = add_investigation(patient_id, "Bloods", BLOOD_A, (now - timedelta(days=3)).isoformat())
        add_investigation(patient_id, "Bloods", BLOOD_B, (now - timedelta(hours=1)).isoformat())

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

            # ---- Before edit: newest Bloods is ENTRY_B ----
            before = export_pdf(page, "before")
            assert BLOOD_B in before, "pre-edit PDF should show the newest Bloods (ENTRY_B)"
            assert BLOOD_A not in before, "pre-edit PDF should NOT show the older Bloods (ENTRY_A)"

            # ---- Edit ENTRY_A's collection date to be the newest ----
            edit_collection_date(entry_a, now.isoformat())

            # ---- After edit: newest Bloods is now ENTRY_A ----
            after = export_pdf(page, "after")
            assert BLOOD_A in after, (
                "post-edit PDF should show ENTRY_A after its collection date was made newest"
            )
            assert BLOOD_B not in after, (
                "post-edit PDF still shows ENTRY_B — the edited collection date was not reflected "
                "in the newest-per-category selection"
            )

            browser.close()

        print("PASS: exported PDF reflects the newest-per-category change after editing a collection date")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
