"""
End-to-end test: discharging a patient through the real Status-tab UI, then
exporting the handover PDF, produces a sheet whose location/status cell shows
the "Discharged" status, the discharge destination ("To <destination>") AND the
discharged date ("Disch <dd/mm/yyyy>") — with NO stale status values (the cell
must not still read "Admitted" or "Died" for this patient).

Column source: location() in src/lib/handover-columns.ts renders, for a
discharged patient:

  <ward · Bed n>
  Discharged
  To <discharge_destination>
  Adm <dd/mm/yyyy>
  Disch <dd/mm/yyyy>

Discharged patients live in the archived list, so the export is taken with the
"Archive" filter toggled on.

Steps:
  1. Seed one admitted patient.
  2. Sign in, open the patient, via the Status tab pick "Discharged", choose a
     discharge date (today), type a discharge destination; save.
  3. Confirm the DB stored status=discharged + destination + discharge_date.
  4. On /patients, toggle Archive, export + download the handover PDF.
  5. Assert the patient's location cell shows Discharged + To <dest> + Disch
     <date>, and that it contains NO stale "Admitted"/"Died" status.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-discharge-destination-date-no-stale.e2e.py
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

MARKER = f"E2EPDFDDN{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "D.N.PDF"
DEST = f"Ward 8 rehab {MARKER}"


def packed(s):
    return "".join(s.split())


def fmt_date_gb(iso_date):
    """Match src/lib/icu.ts fmtDate: en-GB dd/mm/yyyy."""
    d = datetime.fromisoformat(iso_date)
    return f"{d.day:02d}/{d.month:02d}/{d.year:04d}"


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
            "ward": "Critical Care",
            "bed": "3",
            "hospital_number": f"H-{MARKER}",
            "current_admission": f"Admitted for observation {MARKER}",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination",
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


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def pick_today(page):
    page.get_by_role("button", name="DD/MM/YYYY").click()
    now = datetime.now(timezone.utc)
    data_day = f"{now.month}/{now.day}/{now.year}"
    cell = page.locator(f"button[data-day='{data_day}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


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
        today_iso = datetime.now(timezone.utc).date().isoformat()
        disch_date_gb = fmt_date_gb(today_iso)

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

            # ---- 1. Discharge with destination + date via the Status tab UI ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            panel = open_status_tab(page)
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Discharged").click()
            expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
            pick_today(page)
            panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DEST)
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            # ---- 2. Confirm persisted ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status not stored: {row['status']!r}"
            assert row["discharge_destination"] == DEST, (
                f"destination not stored: {row['discharge_destination']!r}"
            )
            assert row["discharge_date"] == today_iso, (
                f"discharge date not stored: {row['discharge_date']!r} != {today_iso!r}"
            )

            # ---- 3. Export the archived handover PDF ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            page.get_by_role("button", name="Archive").click()
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dlg = page.get_by_role("dialog")
            download_btn = dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=60000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # ---- Patient present, discharged status + destination + date render ----
        assert packed(PATIENT_NAME) in packed_text, "discharged patient missing from PDF"
        assert "Discharged" in raw_text, "'Discharged' status not rendered in PDF"

        dest_token = packed(f"To {DEST}")
        assert dest_token in packed_text, (
            f"discharge destination not rendered as 'To {DEST}' in PDF"
        )
        disch_token = packed(f"Disch {disch_date_gb}")
        assert disch_token in packed_text, (
            f"discharge date not rendered as 'Disch {disch_date_gb}' in PDF"
        )

        # ---- No stale status: this patient's cell (around the unique DEST marker)
        #      must read Discharged, never Admitted/Died. ----
        idx = packed_text.find(dest_token)
        window = packed_text[max(0, idx - 60): idx + len(dest_token) + 80]
        assert "Discharged" in window, (
            f"'Discharged' not adjacent to this patient's cell; window: {window!r}"
        )
        assert "Admitted" not in window, (
            f"stale 'Admitted' status found in discharged patient's cell: {window!r}"
        )
        assert "Died" not in window, (
            f"stale 'Died' status found in discharged patient's cell: {window!r}"
        )
        assert disch_token in window, (
            f"'Disch {disch_date_gb}' not within this patient's cell: {window!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: handover PDF shows Discharged status, discharge destination and "
            "discharged date, with no stale Admitted/Died status for the patient"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
