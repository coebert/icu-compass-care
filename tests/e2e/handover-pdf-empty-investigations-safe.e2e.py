"""
End-to-end test: exporting a handover PDF for a patient with NO Bloods / CXR /
CT chest investigations renders the "Most recent investigations" section safely
— each key category shows an em-dash placeholder and NO stale/leaked values.

The handover sheet always renders one line per key category (Bloods / CXR /
CT chest). When a category has no result it must render `<Category>: —`
(see investigations() in src/lib/handover-pdf.ts), never a blank, a crash, or a
value carried over from another investigation category or another patient.

This test proves the empty path end to end:

  1. Seed a patient with ZERO key-block investigations. To make "no stale
     values" concrete it ALSO gets one NON-key investigation (category "ECG")
     whose finding must never appear in the Bloods/CXR/CT chest lines, and a
     SECOND patient WITH real Bloods/CXR/CT chest results — proving the empty
     patient's section does not borrow the other patient's findings.
  2. Restore a clinician session, open /patients, Preview PDF -> Download PDF.
  3. Extract the PDF text (pdftotext) and assert:
       - each key category renders with the em-dash placeholder
       - the NON-key "ECG" finding does not leak into the key-block lines
       - the other patient's key findings appear exactly once (their row only),
         i.e. they did not bleed into the empty patient's placeholders.

Throwaway clinician user + patients (+investigations) are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-empty-investigations-safe.e2e.py
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

MARKER = f"E2EPDFEMPTY{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
SUFFIX = str(int(time.time()))[-6:]

# The patient under test has NO Bloods/CXR/CT chest — only a non-key "ECG".
EMPTY_PATIENT_NAME = "E.M.P."
NONKEY_FINDING = f"ECGONLY{SUFFIX}"

# A second patient WITH real key results, to prove no cross-row bleed.
OTHER_PATIENT_NAME = "O.T.H."
OTHER_KEY = {
    "Bloods": f"OBLOODS{SUFFIX}",
    "CXR": f"OCXR{SUFFIX}",
    "CT chest": f"OCT{SUFFIX}",
}

now_iso = datetime.now(timezone.utc).isoformat()


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


def create_patient(name, age):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "age": age,
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


def delete_patient(patient_id):
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


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        if pid:
            delete_patient(pid)
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
    # Collapse whitespace so wrapped table cells don't hide single-token markers.
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = None
    empty_id = other_id = None
    try:
        user_id, email = create_user()
        empty_id = create_patient(EMPTY_PATIENT_NAME, 61)
        other_id = create_patient(OTHER_PATIENT_NAME, 72)

        # Empty patient: only a NON-key investigation, no Bloods/CXR/CT chest.
        add_investigation(empty_id, "ECG", NONKEY_FINDING, now_iso)
        # Other patient: real key results.
        for category, finding in OTHER_KEY.items():
            add_investigation(other_id, category, finding, now_iso)

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

            expect(page.get_by_text(EMPTY_PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

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

        # ---- The empty patient rendered (no crash producing a blank sheet) ----
        assert EMPTY_PATIENT_NAME.replace(" ", "") in packed or EMPTY_PATIENT_NAME in raw_text, (
            "empty-investigations patient row missing from handover PDF"
        )

        # ---- Each key category renders with the em-dash placeholder ----
        # investigations() emits "<Category>: —" when no result exists; packed
        # text collapses the space to "<Category>:—".
        for category in ("Bloods", "CXR", "CT chest"):
            token = f"{category.replace(' ', '')}:—"
            assert token in packed, (
                f"key category '{category}' did not render the em-dash placeholder "
                f"({token!r} not found) — empty investigations section is unsafe"
            )

        # ---- The non-key ECG finding must NOT appear in the key-block lines ----
        # It's not one of Bloods/CXR/CT chest, so it must never surface there.
        assert f"Bloods:{NONKEY_FINDING}" not in packed, (
            "non-key ECG finding leaked into the Bloods line"
        )
        assert f"CXR:{NONKEY_FINDING}" not in packed, (
            "non-key ECG finding leaked into the CXR line"
        )
        assert f"CTchest:{NONKEY_FINDING}" not in packed, (
            "non-key ECG finding leaked into the CT chest line"
        )

        # ---- No cross-row bleed: the other patient's key findings appear
        #      exactly once (their own row) and never against a placeholder ----
        for category, finding in OTHER_KEY.items():
            assert packed.count(finding) == 1, (
                f"other patient's {category} finding '{finding}' appears "
                f"{packed.count(finding)} times — expected exactly once (stale bleed?)"
            )
            # And the empty patient's slot for this category is still a placeholder.
            assert f"{category.replace(' ', '')}:{finding}" in packed, (
                f"other patient's {category} value not rendered against their own row"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: empty investigations render em-dash placeholders safely; "
            "no non-key or cross-patient values leak in"
        )
        return 0
    finally:
        cleanup([empty_id, other_id], user_id)


if __name__ == "__main__":
    sys.exit(main())
