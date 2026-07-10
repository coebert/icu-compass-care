"""
End-to-end test: downloading a handover with a HOSTILE header title produces a
safe, sanitized download filename (the same value that guards the
Content-Disposition header).

The handover download is a client-side blob download: the app builds the PDF,
runs the title through `formatHandoverFilename` → `sanitizeContentDispositionFilename`
(src/lib/handover-pdf.ts), and assigns the result to the anchor's `download`
attribute. In a browser download that value is exactly what a server would put
in a `Content-Disposition: attachment; filename="…"` header, and Playwright
surfaces it as `download.suggested_filename`.

This test:

  1. Seeds a patient and a clinician, signs in, opens the patients list.
  2. Opens the Handover PDF preview modal and sets a HOSTILE header title
     containing path separators, quotes, and Windows/​header-illegal characters
     (`../../ICU"Handover:*?<>|Sheet`), with a deterministic `{title}.pdf`
     filename format so no timestamp varies the result.
  3. Clicks "Download PDF" and captures the download.
  4. Asserts the suggested filename:
       - equals the app's own sanitized "Download: …" preview text,
       - contains NONE of the hostile characters (`/ \\ : * ? < > | "` or control chars),
       - has no path traversal (`..`), and ends with `.pdf`.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-pdf-hostile-filename.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
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

MARKER = f"E2EHOSTILE{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "H.O.S."

# Path separators, quotes, and Windows/header-illegal characters.
HOSTILE_TITLE = '../../ICU"Handover:*?<>|Sheet'
# Deterministic filename (no timestamp) so we can assert an exact value.
FILENAME_FORMAT = "{title}.pdf"

# Characters that must NEVER survive into a download/Content-Disposition name.
FORBIDDEN_CHARS = set('/\\:*?<>|"')


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
            "age": 60,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800}, accept_downloads=True
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

            # Open the Handover PDF preview modal.
            page.get_by_role("button", name="Preview PDF").click()
            expect(page.get_by_text("Handover PDF preview", exact=False).first).to_be_visible(timeout=15000)

            # Set the deterministic filename format, then the hostile title.
            filename_input = page.locator("#pdf-filename")
            filename_input.fill(FILENAME_FORMAT)
            title_input = page.locator("#pdf-title")
            title_input.fill(HOSTILE_TITLE)

            # The modal shows a live "Download: <name>" preview of the sanitized
            # filename. Read it — this is the app's own sanitizer output.
            preview_locator = page.get_by_text(re.compile(r"^Download:\s*"))
            expect(preview_locator).to_be_visible(timeout=10000)
            preview_text = preview_locator.inner_text().split("Download:", 1)[1].strip()

            # Wait for the preview blob to be ready so the Download button enables.
            download_button = page.get_by_role("button", name="Download PDF")
            expect(download_button).to_be_enabled(timeout=15000)

            with page.expect_download(timeout=15000) as dl_info:
                download_button.click()
            download = dl_info.value
            suggested = download.suggested_filename

            page.screenshot(path=str(SCREENSHOTS / f"hostile_filename_{MARKER}.png"))
            browser.close()

        # The download name must match the app's sanitized preview exactly.
        assert suggested == preview_text, (
            f"download filename '{suggested}' != sanitized preview '{preview_text}'"
        )

        # And it must actually be sanitized.
        assert suggested.lower().endswith(".pdf"), f"filename should end with .pdf: {suggested!r}"
        assert ".." not in suggested, f"path traversal survived sanitization: {suggested!r}"
        bad = FORBIDDEN_CHARS.intersection(suggested)
        assert not bad, f"forbidden filename characters survived: {sorted(bad)} in {suggested!r}"
        assert not any(ord(c) < 0x20 or ord(c) == 0x7F for c in suggested), (
            f"control characters survived in filename: {suggested!r}"
        )
        # None of the hostile title fragments should appear verbatim.
        for fragment in ('"', "*", "?", "<", ">", "|", "/"):
            assert fragment not in suggested, f"hostile fragment '{fragment}' in {suggested!r}"

        print(f"PASS: hostile title sanitized to safe download filename '{suggested}'")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
