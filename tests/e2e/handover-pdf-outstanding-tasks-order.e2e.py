"""
End-to-end test: recording outstanding tasks for a patient (via the patient
edit UI) surfaces them in the exported handover PDF in the SAME order they were
entered, each with its completion status preserved.

Outstanding tasks are captured as a free-text field (PatientForm ->
"Outstanding tasks" textarea) and rendered verbatim into the handover sheet's
"Outstanding tasks" column by src/lib/handover-pdf.ts (p.outstanding_tasks).
Clinicians record them as an ordered checklist where completion status is
encoded inline, e.g.:

  [x] Chase potassium result
  [x] Consent for line insertion
  [ ] Refer to physio
  [ ] Family update call

This test enters exactly that ordered checklist through the real Edit dialog,
saves, exports the PDF, and asserts:

  1. Every task line (with its [x]/[ ] completion marker) appears in the PDF.
  2. The tasks appear in the ORDER they were entered (done items before the
     outstanding ones here), verified by their positions in the extracted text.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-outstanding-tasks-order.e2e.py
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

MARKER = f"E2ETASKS{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"TASKS.{str(int(time.time()))[-4:]}"

# Ordered checklist: two completed, two still outstanding. Order matters.
TASKS = [
    f"[x] Chase potassium result {MARKER}",
    f"[x] Consent for line insertion {MARKER}",
    f"[ ] Refer to physiotherapy {MARKER}",
    f"[ ] Family update phone call {MARKER}",
]
TASKS_TEXT = "\n".join(TASKS)


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
            "age": 61,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "9",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
            "outstanding_tasks": "",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_tasks(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=outstanding_tasks",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["outstanding_tasks"]


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

            # ---- Record outstanding tasks through the patient edit UI.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            page.get_by_role("button", name="Edit").click()
            dlg = page.get_by_role("dialog")
            expect(dlg).to_be_visible(timeout=10000)

            # The Field label is not htmlFor-linked to the textarea, so scope to
            # the field container that holds the "Outstanding tasks" label.
            container = dlg.locator("div.space-y-1\\.5").filter(
                has=page.get_by_text("Outstanding tasks", exact=True)
            )
            tasks_field = container.get_by_role("textbox")
            tasks_field.click()
            tasks_field.fill(TASKS_TEXT)

            dlg.get_by_role("button", name="Save changes").click()
            expect(dlg).to_be_hidden(timeout=15000)

            # Confirm the DB stored the ordered checklist verbatim.
            stored = read_tasks(patient_id)
            assert stored == TASKS_TEXT, (
                f"stored outstanding_tasks mismatch:\n{stored!r}\nexpected:\n{TASKS_TEXT!r}"
            )

            # ---- Export + download the handover PDF.
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            pdlg = page.get_by_role("dialog")
            download_btn = pdlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # 1) Every task line — with its completion marker — is present.
        positions = []
        for task in TASKS:
            needle = packed(task)
            idx = packed_text.find(needle)
            assert idx != -1, (
                f"outstanding task missing from PDF: {task!r}"
            )
            positions.append(idx)

        # 2) Tasks appear in the exact order they were entered (completed first,
        #    then still-outstanding), as reflected by their positions in the PDF.
        assert positions == sorted(positions), (
            f"outstanding tasks not rendered in entry order; positions={positions}"
        )

        # Sanity: completion markers survived — both done and not-done present.
        assert packed("[x]") in packed_text, "completed-task marker '[x]' missing from PDF"
        assert packed("[ ]") in packed_text, "outstanding-task marker '[ ]' missing from PDF"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: outstanding tasks recorded via the edit UI render in the "
            "handover PDF in entry order with their completion status preserved"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
