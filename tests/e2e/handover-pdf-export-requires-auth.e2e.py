"""
End-to-end test: the handover PDF export is gated by authentication.

Two halves, same seeded patient:

  A) LOGGED OUT — the export must be blocked. With no session:
     - navigating to /patients redirects to /auth (the export UI is
       unreachable), and
     - the underlying patient data is not readable: an anonymous Data API
       read for the seeded patient returns no rows (RLS blocks it), so there
       is nothing an unauthenticated caller could render into a PDF.

  B) LOGGED IN — the SAME patient export succeeds. After signing in with valid
     credentials, /patients loads, the handover PDF exports and downloads, and
     the seeded patient appears in the extracted PDF text.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-export-requires-auth.e2e.py
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

MARKER = f"E2EPDFAUTH{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"AUTH.GATE.{str(int(time.time()))[-4:]}"


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
            "age": 55,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def anon_read_patient(patient_id):
    """Attempt to read the seeded patient as an anonymous (logged-out) caller."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=id,full_name",
        headers={
            "apikey": PUBLISHABLE_KEY,
            "Authorization": f"Bearer {PUBLISHABLE_KEY}",
        },
        timeout=30,
    )
    return r


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

        # ---- A) LOGGED OUT: the data underpinning the export is not readable.
        anon = anon_read_patient(patient_id)
        rows = anon.json() if anon.headers.get("content-type", "").startswith("application/json") else None
        assert anon.status_code in (200, 401, 403), (
            f"unexpected anon read status: {anon.status_code} {anon.text[:200]!r}"
        )
        assert not rows, (
            "logged-out (anon) caller could read the seeded patient — RLS is not "
            f"blocking the export data: {rows!r}"
        )

        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            # ---- A) LOGGED OUT: /patients (the export UI) is unreachable.
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page).to_have_url(lambda u: "/auth" in u, timeout=15000)
            assert page.get_by_role("button", name="Preview PDF").count() == 0, (
                "Preview PDF control is present while logged out"
            )

            # ---- B) LOG IN with valid credentials, then export succeeds.
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"still bounced to /auth after login: {page.url}"

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
        assert packed(PATIENT_NAME) in packed_text, (
            "seeded patient missing from the authenticated export PDF"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: handover PDF export is blocked while logged out "
            "(/patients redirects to /auth and anon data read is denied), "
            "and succeeds for the same patient after signing in"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
