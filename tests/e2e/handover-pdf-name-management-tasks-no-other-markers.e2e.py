"""
End-to-end test: the downloaded handover PDF for a single patient contains that
patient's saved NAME and key clinical sections (current management and
outstanding tasks), and contains NO markers belonging to any OTHER patient.

This asserts on the real bytes of the exported document:
  1. The download is a genuine PDF (magic bytes start with "%PDF-").
  2. The extracted text includes the target patient's name marker.
  3. The extracted text includes the target patient's Current management marker
     and each of its Outstanding tasks markers (the key sections).
  4. NONE of a decoy patient's markers (name / management / tasks) appear —
     no cross-patient bleed into the target's PDF.

The board's "Preview PDF" export renders the currently FILTERED list, so we
narrow the board to exactly the target patient by typing its unique hospital
number into the search box before exporting.

Throwaway clinician user + two patients (target + decoy) are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-name-management-tasks-no-other-markers.e2e.py
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

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

# Target patient — everything that MUST appear in its PDF.
TGT_NAME = f"Tgtwood{SUFFIX}"
TGT_HN = f"HNT{SUFFIX}"
TGT_MGMT = f"TgtMgmt{SUFFIX}"
TGT_TASK1 = f"TgtTaskA{SUFFIX}"
TGT_TASK2 = f"TgtTaskB{SUFFIX}"
TGT_PRESENT = [TGT_NAME, TGT_MGMT, TGT_TASK1, TGT_TASK2]

# Decoy patient — NONE of these may appear in the target's PDF.
DEC_NAME = f"Decwood{SUFFIX}"
DEC_HN = f"HND{SUFFIX}"
DEC_MGMT = f"DecMgmt{SUFFIX}"
DEC_TASK = f"DecTask{SUFFIX}"
DEC_ABSENT = [DEC_NAME, DEC_MGMT, DEC_TASK]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-pdfnametask-{STAMP}@example.com"
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


def create_patient(name, hn, mgmt, tasks):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "hospital_number": hn,
            "age": 62,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "5",
            "status": "admitted",
            "current_admission": f"Admission {name}",
            "current_management": mgmt,
            "outstanding_tasks": tasks,
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


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        if pid:
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
    # Return both readable text and a whitespace-stripped ("packed") form so a
    # marker split across line wraps is still detected.
    return out.stdout, "".join(out.stdout.split())


def export_pdf_for(page, hospital_number, out_path):
    search = page.get_by_placeholder("Search initials or hospital no.…")
    search.fill("")
    search.fill(hospital_number)
    page.wait_for_timeout(500)

    preview_btn = page.get_by_role("button", name="Preview PDF")
    expect(preview_btn).to_be_enabled(timeout=15000)
    preview_btn.click()

    dialog = page.get_by_role("dialog")
    download_btn = dialog.get_by_role("button", name="Download PDF")
    expect(download_btn).to_be_enabled(timeout=20000)

    with page.expect_download(timeout=30000) as dl_info:
        download_btn.click()
    download = dl_info.value
    download.save_as(str(out_path))
    assert download.suggested_filename.lower().endswith(".pdf")


def main():
    user_id = None
    pid_tgt = pid_dec = None
    pdf_path = SCREENSHOTS / f"handover_nametask_{STAMP}.pdf"
    try:
        user_id, email = create_user()
        pid_tgt = create_patient(
            TGT_NAME, TGT_HN, TGT_MGMT, f"{TGT_TASK1}\n{TGT_TASK2}"
        )
        pid_dec = create_patient(DEC_NAME, DEC_HN, DEC_MGMT, DEC_TASK)

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
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            expect(
                page.get_by_text(TGT_NAME, exact=False).first
            ).to_be_visible(timeout=15000)

            export_pdf_for(page, TGT_HN, pdf_path)
            browser.close()

        # ---- 1. Genuine PDF (magic bytes) ----
        head = pdf_path.read_bytes()[:5]
        assert head == b"%PDF-", f"downloaded file is not a PDF, header={head!r}"

        raw, packed = extract_pdf_text(pdf_path)

        # ---- 2 & 3. Target name + key sections present ----
        missing = [m for m in TGT_PRESENT if m not in packed]
        assert not missing, f"target patient PDF missing expected markers: {missing}"

        # The section headings themselves should be rendered.
        packed_ci = packed.lower()
        assert "management" in packed_ci, "PDF missing a 'management' section heading"
        assert "outstanding" in packed_ci or "task" in packed_ci, (
            "PDF missing an 'outstanding tasks' section heading"
        )

        # ---- 4. No decoy patient markers ----
        leaked = [m for m in DEC_ABSENT if m in packed]
        assert not leaked, (
            f"target patient PDF leaked another patient's markers: {leaked}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: handover PDF contains the patient's name, current management "
            "and outstanding tasks, and no other patient's markers"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup([pid_tgt, pid_dec], user_id)


if __name__ == "__main__":
    sys.exit(main())
