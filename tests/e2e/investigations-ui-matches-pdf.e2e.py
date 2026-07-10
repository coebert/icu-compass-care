"""
End-to-end UI test: the Investigations "Most recent" blocks shown on the
patient detail page must EXACTLY match what appears in the downloaded handover
PDF's investigations column.

Both surfaces use the same selection logic (mostRecentInvestigation over
RECENT_INVESTIGATION_CATEGORIES = Bloods / CXR / CT chest). This test proves the
on-screen blocks and the exported PDF agree, end to end, by:

  1. Seeding a patient with SEVERAL results per category (out of order).
  2. Opening the patient detail page and reading the exact "most recent"
     finding text shown in each category block from the DOM.
  3. Exporting the handover PDF via the real UI (Preview -> Download).
  4. Extracting the PDF text and asserting, per category:
       - the finding shown in the UI block appears verbatim in the PDF
       - no other (older, superseded) seeded finding for that category appears
         in either the UI block or the PDF.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/investigations-ui-matches-pdf.e2e.py
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

MARKER = f"E2EUIPDF{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "U.I.P."

SUFFIX = str(int(time.time()))[-6:]
now = datetime.now(timezone.utc)

# (finding, result_at) per category, oldest -> newest. Newest is last.
BLOCKS = {
    "Bloods": [
        (f"BOLDA{SUFFIX}", now - timedelta(days=3)),
        (f"BOLDB{SUFFIX}", now - timedelta(days=1)),
        (f"BNEW{SUFFIX}", now - timedelta(hours=1)),
    ],
    "CXR": [
        (f"CXOLDA{SUFFIX}", now - timedelta(days=2)),
        (f"CXNEW{SUFFIX}", now - timedelta(hours=2)),
    ],
    "CT chest": [
        (f"CTOLDA{SUFFIX}", now - timedelta(days=4)),
        (f"CTOLDB{SUFFIX}", now - timedelta(hours=8)),
        (f"CTNEW{SUFFIX}", now - timedelta(hours=3)),
    ],
}


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
            "age": 62,
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

        # Seed OUT OF ORDER: within each category insert newest first.
        for category, entries in BLOCKS.items():
            for finding, when in reversed(entries):
                add_investigation(patient_id, category, finding, iso(when))

        session = sign_in(email)

        all_findings = {f for entries in BLOCKS.values() for f, _ in entries}

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

            # --- 1. Read the "Most recent" blocks from the patient detail page ---
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            card = page.get_by_text("Most recent investigations", exact=False).first
            expect(card).to_be_visible(timeout=15000)
            # Wait for at least one seeded finding to render.
            expect(page.get_by_text(BLOCKS["Bloods"][-1][0], exact=False).first).to_be_visible(timeout=15000)

            page.screenshot(path=str(SCREENSHOTS / f"investigations_ui_{MARKER}.png"))

            ui_text = page.locator("body").inner_text()
            ui_packed = "".join(ui_text.split())

            # For each category, exactly one seeded finding (the newest) must be
            # shown in the "most recent" block; older ones must be absent.
            ui_shown = {}
            for category, entries in BLOCKS.items():
                *older, (newest, _) = entries
                assert newest in ui_packed, (
                    f"UI most-recent block for {category} does not show newest '{newest}'"
                )
                for old_finding, _ in older:
                    assert old_finding not in ui_packed, (
                        f"UI shows superseded '{old_finding}' for {category}"
                    )
                ui_shown[category] = newest

            # --- 2. Export the PDF from the patients board ---
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
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

            browser.close()

        raw_text, pdf_packed = extract_pdf_text(pdf_path)

        # --- 3. The PDF must show EXACTLY the same finding the UI block shows ---
        for category, newest in ui_shown.items():
            assert category in raw_text, f"PDF missing '{category}' label"
            assert newest in pdf_packed, (
                f"{category}: UI shows '{newest}' but the PDF does not — surfaces disagree"
            )

        # No older seeded finding should appear in the PDF for any category.
        for category, entries in BLOCKS.items():
            for old_finding, _ in entries[:-1]:
                assert old_finding not in pdf_packed, (
                    f"{category}: superseded '{old_finding}' leaked into the PDF"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print("PASS: Investigations 'most recent' blocks match the downloaded PDF exactly")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
