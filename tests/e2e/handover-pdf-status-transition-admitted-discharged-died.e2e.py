"""
End-to-end test: driving a single patient through the real Status-tab UI from
Admitted -> Discharged -> Died, exporting the handover PDF after EACH change,
and verifying every exported PDF shows the correct status label and the
matching discharge / died details for that stage.

This is a lifecycle-consistency guard for the handover sheet. The
"Location / status" column (location() in src/lib/handover-pdf.ts) renders:
  - the status label from STATUS_LABELS ("Admitted" / "Discharged" / "Died")
  - "To <discharge_destination>" ONLY while status === "discharged"
So each stage must show its own label and MUST NOT leak the other stages'
details (a discharged patient's "To ..." line must be gone once died, and no
"Discharged"/"Died" label may appear while still admitted).

Steps:
  1. Seed one ADMITTED patient (distinct bed) via the admin REST API.
  2. Sign in as a throwaway clinician.
  3. STAGE A — current view: export PDF, assert "Admitted", and that neither
     "Discharged", "Died", nor the destination "To ..." line appears.
  4. Change status to Discharged (date + destination) via the Status tab UI.
  5. STAGE B — archive view: export PDF, assert "Discharged" and "To <dest>",
     and that "Died" does NOT appear.
  6. Change status to Died (date of death) via the Status tab UI.
  7. STAGE C — archive view: export PDF, assert "Died", and that neither
     "Discharged" nor the destination "To ..." line appears.

All assertions are scoped to the patient's own row window in the PDF so no
other archived record can satisfy them.

Throwaway clinician user + patient are created/cleaned via the admin REST API.
Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-status-transition-admitted-discharged-died.e2e.py
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

MARKER = f"E2ESTATUS{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

PATIENT_NAME = f"STX.{MARKER}"
BED = "47"
DESTINATION = f"Ward{MARKER}"  # single token -> stays on one PDF line
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=6)).isoformat()

TODAY = datetime.now(timezone.utc)
TODAY_ISO = TODAY.date().isoformat()
DATA_DAY = f"{TODAY.month}/{TODAY.day}/{TODAY.year}"


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


def create_admitted_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": BED,
            "status": "admitted",
            "admission_date": ADMISSION_DATE,
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


def read_status(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination,date_of_death",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


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


def packed(s):
    """Whitespace-free text so cell/line wrapping in the narrow PDF columns
    cannot split a name or label across lines and hide a match."""
    return "".join(s.split())


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return packed(out.stdout)


def row_window(packed_text, name):
    """Return the slice of packed PDF text belonging to the patient's row.
    There is only one seeded patient, but the bounded window keeps assertions
    robust if the archive view holds other records."""
    start = packed_text.find(packed(name))
    assert start != -1, f"patient {name!r} not found in exported PDF"
    return packed_text[start : start + 400]


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def pick_today(page):
    page.get_by_role("button", name="DD/MM/YYYY").click()
    cell = page.locator(f"button[data-day='{DATA_DAY}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


def export_pdf(page, archived, expect_name, suffix):
    """From /patients, optionally toggle Archive, then Preview + Download the
    handover PDF and return its extracted text."""
    page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

    if archived:
        page.get_by_role("button", name="Archive").click()

    expect(page.get_by_text(expect_name, exact=False).first).to_be_visible(timeout=15000)

    preview_btn = page.get_by_role("button", name="Preview PDF")
    expect(preview_btn).to_be_enabled(timeout=15000)
    preview_btn.click()

    dlg = page.get_by_role("dialog")
    download_btn = dlg.get_by_role("button", name="Download PDF")
    expect(download_btn).to_be_visible(timeout=10000)
    with page.expect_download(timeout=15000) as dl_info:
        download_btn.click()
    download = dl_info.value
    pdf_path = SCREENSHOTS / f"handover_{MARKER}_{suffix}.pdf"
    download.save_as(str(pdf_path))
    assert download.suggested_filename.lower().endswith(".pdf")

    text = extract_pdf_text(pdf_path)
    try:
        pdf_path.unlink()
    except OSError:
        pass
    return text


def set_status(page, patient_id, new_status):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

    panel = open_status_tab(page)
    panel.get_by_role("combobox").click()
    label = {"discharged": "Discharged", "died": "Died"}[new_status]
    page.get_by_role("option", name=label, exact=True).click()

    if new_status == "discharged":
        expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
        pick_today(page)
        panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DESTINATION)
    else:  # died
        expect(panel.get_by_text("Date of death")).to_be_visible(timeout=5000)
        pick_today(page)

    panel.get_by_role("button", name="Update status").click()
    expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_admitted_patient()
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

            # ---- STAGE A: Admitted (current view) ----
            dest_packed = packed(f"To {DESTINATION}")
            text_a = export_pdf(page, archived=False, expect_name=PATIENT_NAME, suffix="admitted")
            win_a = row_window(text_a, PATIENT_NAME)
            assert "Admitted" in win_a, f"STAGE A: 'Admitted' missing.\n{win_a!r}"
            assert "Discharged" not in win_a, f"STAGE A: unexpected 'Discharged'.\n{win_a!r}"
            assert "Died" not in win_a, f"STAGE A: unexpected 'Died'.\n{win_a!r}"
            assert dest_packed not in win_a, f"STAGE A: unexpected destination line.\n{win_a!r}"

            # ---- transition Admitted -> Discharged ----
            set_status(page, patient_id, "discharged")
            row = read_status(patient_id)
            assert row["status"] == "discharged", f"DB status not discharged: {row!r}"
            assert row["discharge_destination"] == DESTINATION, f"destination not stored: {row!r}"
            assert row["discharge_date"] == TODAY_ISO, f"discharge date not stored: {row!r}"

            # ---- STAGE B: Discharged (archive view) ----
            text_b = export_pdf(page, archived=True, expect_name=PATIENT_NAME, suffix="discharged")
            win_b = row_window(text_b, PATIENT_NAME)
            assert "Discharged" in win_b, f"STAGE B: 'Discharged' missing.\n{win_b!r}"
            assert dest_packed in win_b, f"STAGE B: destination 'To {DESTINATION}' missing.\n{win_b!r}"
            assert "Died" not in win_b, f"STAGE B: unexpected 'Died'.\n{win_b!r}"

            # ---- transition Discharged -> Died ----
            set_status(page, patient_id, "died")
            row = read_status(patient_id)
            assert row["status"] == "died", f"DB status not died: {row!r}"
            assert row["date_of_death"] == TODAY_ISO, f"date of death not stored: {row!r}"

            # ---- STAGE C: Died (archive view) ----
            text_c = export_pdf(page, archived=True, expect_name=PATIENT_NAME, suffix="died")
            win_c = row_window(text_c, PATIENT_NAME)
            assert "Died" in win_c, f"STAGE C: 'Died' missing.\n{win_c!r}"
            assert "Discharged" not in win_c, f"STAGE C: stale 'Discharged' leaked.\n{win_c!r}"
            assert dest_packed not in win_c, (
                f"STAGE C: stale discharge destination leaked after death.\n{win_c!r}"
            )

            browser.close()

        print(
            "PASS: handover PDF reflects each status transition — "
            "Admitted (no discharge/death details), Discharged (with 'To "
            f"{DESTINATION}'), then Died (no stale discharge details)."
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
