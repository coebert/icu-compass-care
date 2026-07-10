"""
End-to-end UI-to-PDF round-trip test for microbiology result timestamps.

Unlike handover-pdf-microbiology-timestamps.e2e.py (which SEEDS results via the
admin REST API), this test enters microbiology results — including their
date/time of result — through the REAL patient-edit UI (the Microbiology tab's
"Add result" dialog, using the DateTimePicker time field), then exports the
handover PDF and asserts the timestamps rendered in the PDF EXACTLY match what
the UI itself displays for those entries.

Flow:
  1. Create a throwaway clinician + an empty patient (no seeded micro).
  2. Sign in, open the patient detail page, go to the Microbiology tab.
  3. For each of several specimen types, open "Add result", pick the specimen,
     set a distinct time-of-day via the time input, type findings, and Save.
  4. Read back each entry's timestamp AS DISPLAYED in the "Full history" list
     (fmtDateTime, en-GB 'dd/mm/yyyy, HH:MM'). This is the source of truth for
     "what I entered".
  5. Export the handover PDF through the real Preview/Download UI.
  6. Assert every entry renders in the PDF as
     `<specimen>: <findings> (<displayed timestamp>)`, proving the exported
     timestamps match the patient-edit screen.

Browser timezone is pinned (Europe/London) so date/time handling is
deterministic. Throwaway user + patient are cleaned up via the admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-ui-roundtrip.e2e.py
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

MARKER = f"E2EMICROUI{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"U.R.T.{str(int(time.time()))[-4:]}"

TZ_ID = "Europe/London"
SUFFIX = str(int(time.time()))[-6:]

# (specimen type, findings, time-of-day HH:MM) — distinct times, entered via UI.
ENTRIES = [
    ("Blood culture", f"BCfind{SUFFIX}", "06:42"),
    ("Urine", f"URfind{SUFFIX}", "13:37"),
    ("CSF", f"CSFfind{SUFFIX}", "21:05"),
]


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
            "current_management": f"Mgmt {MARKER}",
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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
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


def add_result_via_ui(page, specimen, findings, hhmm):
    """Drive the Microbiology tab 'Add result' dialog for one entry."""
    page.get_by_role("button", name="Add result").click()

    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=10000)

    # Pick the specimen type from the searchable combobox.
    dialog.get_by_role("combobox").click()
    page.get_by_role("option", name=specimen, exact=True).click()

    # Set the time-of-day (date defaults to today). This is the value under test.
    time_input = dialog.get_by_label("Time")
    time_input.fill(hhmm)

    dialog.get_by_label("Findings").fill(findings)

    dialog.get_by_role("button", name="Save").click()
    expect(dialog).to_be_hidden(timeout=10000)


def read_displayed_timestamp(page, findings):
    """Return the fmtDateTime string the UI shows for the entry with `findings`."""
    # Full-history card: badge(specimen) + span(timestamp) then <p>findings</p>.
    card = page.locator("div").filter(has_text=findings).last
    # The timestamp span sits directly above the findings paragraph in the card.
    stamp = card.locator("span.text-muted-foreground").last.inner_text().strip()
    return stamp


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        displayed = {}

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
                timezone_id=TZ_ID,
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # Open the patient detail page and the Microbiology tab.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth: {page.url}"

            page.get_by_role("tab", name="Microbiology").click()
            expect(page.get_by_role("button", name="Add result")).to_be_visible(timeout=15000)

            # Enter each result through the real UI.
            for specimen, findings, hhmm in ENTRIES:
                add_result_via_ui(page, specimen, findings, hhmm)
                # Confirm it landed in the history list before continuing.
                expect(page.get_by_text(findings, exact=False).first).to_be_visible(timeout=10000)

            page.wait_for_load_state("networkidle")
            page.screenshot(path=str(SCREENSHOTS / f"microui_{MARKER}_entered.png"))

            # Read back what the patient-edit screen DISPLAYS for each entry.
            for specimen, findings, hhmm in ENTRIES:
                displayed[findings] = read_displayed_timestamp(page, findings)
                assert displayed[findings], f"no displayed timestamp for {findings}"

            # Export the handover PDF through the real UI.
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
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed = extract_pdf_text(pdf_path)
        assert "Key microbiology" in raw_text, "missing microbiology column header"

        # Every entry must render with the EXACT timestamp the UI displayed.
        for specimen, findings, hhmm in ENTRIES:
            stamp = displayed[findings]
            # Sanity: the time-of-day we typed must be part of the displayed stamp.
            assert hhmm in stamp, (
                f"UI displayed '{stamp}' for {specimen} but we entered time {hhmm}"
            )
            expected = "".join(f"{specimen}: {findings} ({stamp})".split())
            assert expected in packed, (
                f"{specimen}: expected '{specimen}: {findings} ({stamp})' in PDF; "
                f"UI-entered timestamp did not round-trip. displayed={stamp}"
            )

        print("PASS: UI-entered microbiology timestamps round-trip into the PDF")
        for specimen, findings, hhmm in ENTRIES:
            print(f"  {specimen}: entered {hhmm} -> displayed/PDF '{displayed[findings]}'")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
