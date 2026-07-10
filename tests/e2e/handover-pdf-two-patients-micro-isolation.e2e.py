"""
End-to-end test: exporting two DIFFERENT patients' handover PDFs in sequence
keeps their microbiology fully isolated — each PDF shows ONLY its own latest
microbiology results, with no cross-contamination between exports.

The handover PDF includes whichever patients are currently visible on the
board (src/routes/_authenticated/patients.index.tsx `filtered` -> passed to
HandoverPreviewModal). The board has a search box that filters by initials /
hospital number / ward. This test seeds two patients, each with a UNIQUE
hospital number and DIFFERENT microbiology (different specimens AND different
findings), then:

  1. Searches for patient A (by hospital number) so only A is on the board,
     exports the PDF, and asserts it contains A's latest micro findings and
     NONE of B's.
  2. Searches for patient B, exports the PDF, and asserts it contains B's
     latest micro findings and NONE of A's.

Each specimen also carries a superseded (older) result to confirm the
"latest per specimen only" rule still holds within each isolated export.

Throwaway clinician user + two patients (+microbiology) are created and cleaned
up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-two-patients-micro-isolation.e2e.py
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

MARKER = f"E2EPDF2PM{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"

SUFFIX = str(int(time.time()))[-6:]
now = datetime.now(timezone.utc)

# Two patients, each with a UNIQUE hospital number (used to filter the board)
# and distinct microbiology. Each specimen has an older (superseded) and a
# newer (shown) result.
PATIENTS = {
    "A": {
        "name": "A.P.X.",
        "hospital_number": f"HNA{SUFFIX}",
        "micro": {
            "Blood culture": [
                (f"ABCOLD{SUFFIX}", now - timedelta(days=3)),
                (f"ABCNEW{SUFFIX}", now - timedelta(hours=2)),
            ],
            "Urine": [
                (f"AUROLD{SUFFIX}", now - timedelta(days=2)),
                (f"AURNEW{SUFFIX}", now - timedelta(hours=6)),
            ],
        },
    },
    "B": {
        "name": "B.P.Y.",
        "hospital_number": f"HNB{SUFFIX}",
        "micro": {
            "Sputum": [
                (f"BSPOLD{SUFFIX}", now - timedelta(days=4)),
                (f"BSPNEW{SUFFIX}", now - timedelta(hours=3)),
            ],
            "Wound swab": [
                (f"BWSOLD{SUFFIX}", now - timedelta(days=5)),
                (f"BWSNEW{SUFFIX}", now - timedelta(hours=8)),
            ],
        },
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


def create_patient(name, hospital_number):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "hospital_number": hospital_number,
            "age": 60,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Mgmt {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_microbiology(patient_id, specimen_type, findings, result_at):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "specimen_type": specimen_type,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    ).raise_for_status()


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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{pid}",
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


def export_pdf_for(page, search_box, hospital_number, marker):
    """Filter the board to a single patient by hospital number, export, return packed PDF text."""
    search_box.fill("")
    search_box.fill(hospital_number)
    # Wait for the filter to settle to exactly one patient row.
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
    pdf_path = SCREENSHOTS / f"handover_{marker}.pdf"
    download.save_as(str(pdf_path))
    assert download.suggested_filename.lower().endswith(".pdf")

    # Close the dialog before the next export.
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    _, packed = extract_pdf_text(pdf_path)
    try:
        pdf_path.unlink()
    except OSError:
        pass
    return packed


def newest_findings(patient):
    return [entries[-1][0] for entries in patient["micro"].values()]


def superseded_findings(patient):
    out = []
    for entries in patient["micro"].values():
        out.extend(f for f, _ in entries[:-1])
    return out


def main():
    user_id = None
    patient_ids = {}
    try:
        user_id, email = create_user()
        for key, spec in PATIENTS.items():
            pid = create_patient(spec["name"], spec["hospital_number"])
            patient_ids[key] = pid
            for specimen, entries in spec["micro"].items():
                for finding, at in reversed(entries):
                    add_microbiology(pid, specimen, finding, iso(at))

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

            expect(page.get_by_text(PATIENTS["A"]["name"], exact=False).first).to_be_visible(timeout=15000)

            search_box = page.get_by_placeholder("Search initials or hospital no.…")

            packed_a = export_pdf_for(page, search_box, PATIENTS["A"]["hospital_number"], f"{MARKER}A")
            packed_b = export_pdf_for(page, search_box, PATIENTS["B"]["hospital_number"], f"{MARKER}B")

            browser.close()

        a_new = [("".join(f.split())) for f in newest_findings(PATIENTS["A"])]
        b_new = [("".join(f.split())) for f in newest_findings(PATIENTS["B"])]
        a_old = [("".join(f.split())) for f in superseded_findings(PATIENTS["A"])]
        b_old = [("".join(f.split())) for f in superseded_findings(PATIENTS["B"])]

        # ---- Patient A's PDF: only A's latest micro; none of B's ----
        for f in a_new:
            assert f in packed_a, f"Patient A PDF missing own latest micro finding '{f}'"
        for f in b_new + b_old:
            assert f not in packed_a, f"Patient A PDF leaked patient B's micro finding '{f}'"
        for f in a_old:
            assert f not in packed_a, f"Patient A PDF leaked superseded finding '{f}'"

        # ---- Patient B's PDF: only B's latest micro; none of A's ----
        for f in b_new:
            assert f in packed_b, f"Patient B PDF missing own latest micro finding '{f}'"
        for f in a_new + a_old:
            assert f not in packed_b, f"Patient B PDF leaked patient A's micro finding '{f}'"
        for f in b_old:
            assert f not in packed_b, f"Patient B PDF leaked superseded finding '{f}'"

        print(
            "PASS: sequential two-patient exports keep microbiology isolated — "
            "each PDF shows only its own latest results"
        )
        return 0
    finally:
        cleanup(list(patient_ids.values()), user_id)


if __name__ == "__main__":
    sys.exit(main())
