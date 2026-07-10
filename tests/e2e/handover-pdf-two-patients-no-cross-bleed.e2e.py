"""
End-to-end test: exporting two DIFFERENT patients' handover PDFs in sequence
must never let one patient's investigations bleed into the other's PDF.

The patient board's "Preview PDF" export renders the currently FILTERED list.
By typing a patient's unique hospital number into the board search, the export
is narrowed to exactly one patient. This test:

  1. Seeds two patients (A and B), each with its OWN unique key investigations
     (Bloods / CXR / CT chest) carrying patient-specific finding markers.
  2. Signs in, filters the board to patient A only, exports + downloads the PDF,
     and asserts A's findings are present while NONE of B's appear.
  3. Clears the filter, filters to patient B only, exports a SECOND PDF, and
     asserts B's findings are present while NONE of A's appear.

This proves the investigations section is scoped per patient and there is no
cross-patient leakage between sequential exports.

Throwaway clinician user + two patients (+investigations) are created and
cleaned up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-two-patients-no-cross-bleed.e2e.py
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

MARKER = f"E2EPDFX{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
SUFFIX = str(int(time.time()))[-6:]

now = datetime.now(timezone.utc)

# Two patients, each with a unique hospital number (used to filter the board to
# exactly that patient) and its OWN per-category investigation markers.
PATIENT_A = {
    "full_name": "A.A.A.",
    "hospital_number": f"HNA{SUFFIX}",
    "findings": {
        "Bloods": f"ABLD{SUFFIX}",
        "CXR": f"ACXR{SUFFIX}",
        "CT chest": f"ACTC{SUFFIX}",
    },
}
PATIENT_B = {
    "full_name": "B.B.B.",
    "hospital_number": f"HNB{SUFFIX}",
    "findings": {
        "Bloods": f"BBLD{SUFFIX}",
        "CXR": f"BCXR{SUFFIX}",
        "CT chest": f"BCTC{SUFFIX}",
    },
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


def create_patient(spec):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": spec["full_name"],
            "hospital_number": spec["hospital_number"],
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


def seed_investigations(patient_id, spec):
    add_investigation(patient_id, "Bloods", spec["findings"]["Bloods"], iso(now - timedelta(hours=1)))
    add_investigation(patient_id, "CXR", spec["findings"]["CXR"], iso(now - timedelta(hours=2)))
    add_investigation(patient_id, "CT chest", spec["findings"]["CT chest"], iso(now - timedelta(hours=3)))


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        if not pid:
            continue
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{pid}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
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


def export_pdf_for(page, hospital_number, out_path):
    """Filter the board to one patient by hospital number, then export the PDF."""
    search = page.get_by_placeholder("Search initials or hospital no.…")
    search.fill("")
    search.fill(hospital_number)
    # Wait for the board to narrow to the single matching patient.
    page.wait_for_timeout(500)

    preview_btn = page.get_by_role("button", name="Preview PDF")
    expect(preview_btn).to_be_enabled(timeout=15000)
    preview_btn.click()

    dialog = page.get_by_role("dialog")
    download_btn = dialog.get_by_role("button", name="Download PDF")
    expect(download_btn).to_be_visible(timeout=10000)

    with page.expect_download(timeout=15000) as dl_info:
        download_btn.click()
    download = dl_info.value
    download.save_as(str(out_path))
    assert download.suggested_filename.lower().endswith(".pdf")

    # Close the modal so the next export starts clean.
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def main():
    user_id = None
    pid_a = pid_b = None
    pdf_a = SCREENSHOTS / f"handover_A_{MARKER}.pdf"
    pdf_b = SCREENSHOTS / f"handover_B_{MARKER}.pdf"
    try:
        user_id, email = create_user()
        pid_a = create_patient(PATIENT_A)
        pid_b = create_patient(PATIENT_B)
        seed_investigations(pid_a, PATIENT_A)
        seed_investigations(pid_b, PATIENT_B)

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

            # Both patients should be on the board first.
            expect(page.get_by_text(PATIENT_A["full_name"], exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_text(PATIENT_B["full_name"], exact=False).first).to_be_visible(timeout=15000)

            # ---- Export #1: patient A only ----
            export_pdf_for(page, PATIENT_A["hospital_number"], pdf_a)

            # ---- Export #2: patient B only ----
            export_pdf_for(page, PATIENT_B["hospital_number"], pdf_b)

            browser.close()

        _, packed_a = extract_pdf_text(pdf_a)
        _, packed_b = extract_pdf_text(pdf_b)

        a_findings = list(PATIENT_A["findings"].values())
        b_findings = list(PATIENT_B["findings"].values())

        # ---- PDF A: contains A's findings, NONE of B's ----
        for f in a_findings:
            assert f in packed_a, f"patient A PDF missing A's own finding '{f}'"
        for f in b_findings:
            assert f not in packed_a, (
                f"patient A PDF leaked patient B's finding '{f}' — cross-patient bleed!"
            )

        # ---- PDF B: contains B's findings, NONE of A's ----
        for f in b_findings:
            assert f in packed_b, f"patient B PDF missing B's own finding '{f}'"
        for f in a_findings:
            assert f not in packed_b, (
                f"patient B PDF leaked patient A's finding '{f}' — cross-patient bleed!"
            )

        # Cleanup artifacts.
        for p in (pdf_a, pdf_b):
            try:
                p.unlink()
            except OSError:
                pass

        print(
            "PASS: sequential per-patient PDF exports keep each patient's "
            "investigations isolated (no cross-patient bleed)"
        )
        return 0
    finally:
        cleanup([pid_a, pid_b], user_id)


if __name__ == "__main__":
    sys.exit(main())
