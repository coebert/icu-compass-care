"""
End-to-end test: DNACPR + Treatment Escalation Plan (TEP) toggle matrix in the
exported handover PDF.

Goal: prove the PDF renders the DNACPR / TEP sections (with their entered
details) ONLY when the corresponding toggle is enabled. Crucially, details text
that is stored in the row but whose toggle is OFF must NEVER leak into the PDF.

We seed four throwaway patients covering every combination, each with UNIQUE
detail strings so presence/absence can be asserted globally against the
extracted PDF text:

  P_BOTH    : dnacpr_decision=True  (+details)   tep_in_place=True  (+details)
  P_DNACPR  : dnacpr_decision=True  (+details)   tep_in_place=False (+details set!)
  P_TEP     : dnacpr_decision=False (+details set!) tep_in_place=True (+details)
  P_NEITHER : dnacpr_decision=False (+details set!) tep_in_place=False (+details set!)

Assertions on the exported PDF:
  * Enabled sections render "DNACPR: <details>" / "TEP: <details>".
  * Disabled sections' detail strings NEVER appear anywhere (even though the
    row stores them) — the flag gates rendering, not the stored text.
  * P_NEITHER contributes neither detail string; its flags cell collapses to
    the em-dash placeholder.
  * When both are on (P_BOTH) they render adjacently, DNACPR before TEP.

Throwaway clinician user + patients are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-tep-dnacpr-toggle-matrix.e2e.py
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

MARKER = f"E2ETOGGLE{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PLACEHOLDER = "\u2014"  # em-dash "—"

SUFFIX = str(int(time.time()))[-6:]

# Unique detail strings so presence/absence is unambiguous in the PDF text.
DNACPR_BOTH = f"DnacprBoth{SUFFIX}"
TEP_BOTH = f"TepBoth{SUFFIX}"
DNACPR_ONLY = f"DnacprOnly{SUFFIX}"
TEP_ONLY = f"TepOnly{SUFFIX}"
# The following are stored on rows whose toggle is OFF and must NOT render.
TEP_HIDDEN = f"TepHidden{SUFFIX}"        # on P_DNACPR (tep off)
DNACPR_HIDDEN = f"DnacprHidden{SUFFIX}"  # on P_TEP (dnacpr off)
DNACPR_NEITHER = f"DnacprNeither{SUFFIX}"  # on P_NEITHER (both off)
TEP_NEITHER = f"TepNeither{SUFFIX}"        # on P_NEITHER (both off)

# Distinct patient names so we can locate each row window in the PDF.
NAME_BOTH = f"ZZBoth{SUFFIX}"
NAME_DNACPR = f"ZZDnacpr{SUFFIX}"
NAME_TEP = f"ZZTep{SUFFIX}"
NAME_NEITHER = f"ZZNeither{SUFFIX}"

PATIENTS = [
    {
        "full_name": NAME_BOTH,
        "dnacpr_decision": True, "dnacpr_details": DNACPR_BOTH,
        "tep_in_place": True, "tep_details": TEP_BOTH,
    },
    {
        "full_name": NAME_DNACPR,
        "dnacpr_decision": True, "dnacpr_details": DNACPR_ONLY,
        "tep_in_place": False, "tep_details": TEP_HIDDEN,
    },
    {
        "full_name": NAME_TEP,
        "dnacpr_decision": False, "dnacpr_details": DNACPR_HIDDEN,
        "tep_in_place": True, "tep_details": TEP_ONLY,
    },
    {
        "full_name": NAME_NEITHER,
        "dnacpr_decision": False, "dnacpr_details": DNACPR_NEITHER,
        "tep_in_place": False, "tep_details": TEP_NEITHER,
    },
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


def create_patients():
    ids = []
    for spec in PATIENTS:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/patients",
            headers={**admin_headers(), "Prefer": "return=representation"},
            json={
                "age": 70,
                "location_type": "icu",
                "ward": "Critical Care",
                "bed": "1",
                "status": "admitted",
                **spec,
            },
            timeout=30,
        )
        r.raise_for_status()
        ids.append(r.json()[0]["id"])
    return ids


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
    for pid in patient_ids or []:
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


ALL_NAMES = [NAME_BOTH, NAME_DNACPR, NAME_TEP, NAME_NEITHER]


def window(packed, name, span=300):
    """Return the packed-text slice for a patient's row, bounded by the next
    of our seeded patient names so it never bleeds into an adjacent row."""
    i = packed.find(name)
    assert i != -1, f"patient row '{name}' not found in PDF"
    start = i + len(name)
    end = i + span
    for other in ALL_NAMES:
        if other == name:
            continue
        j = packed.find(other, start)
        if j != -1:
            end = min(end, j)
    return packed[start:end]


def main():
    user_id = None
    patient_ids = []
    try:
        user_id, email = create_user()
        patient_ids = create_patients()
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
            expect(page.get_by_text(NAME_BOTH, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            export_dialog = page.get_by_role("dialog")
            download_btn = export_dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)

            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed = extract_pdf_text(pdf_path)

        # ---- Enabled sections render with their details ----
        assert f"DNACPR:{DNACPR_BOTH}" in packed, "P_BOTH: DNACPR detail missing"
        assert f"TEP:{TEP_BOTH}" in packed, "P_BOTH: TEP detail missing"
        assert f"DNACPR:{DNACPR_ONLY}" in packed, "P_DNACPR: DNACPR detail missing"
        assert f"TEP:{TEP_ONLY}" in packed, "P_TEP: TEP detail missing"

        # ---- Both on: render adjacently, DNACPR before TEP ----
        assert f"DNACPR:{DNACPR_BOTH}TEP:{TEP_BOTH}" in packed, (
            "P_BOTH: DNACPR and TEP not rendered adjacently in DNACPR->TEP order"
        )

        # ---- Disabled sections' stored details must NEVER appear ----
        for hidden, why in [
            (TEP_HIDDEN, "P_DNACPR TEP off but tep_details leaked"),
            (DNACPR_HIDDEN, "P_TEP DNACPR off but dnacpr_details leaked"),
            (DNACPR_NEITHER, "P_NEITHER DNACPR off but dnacpr_details leaked"),
            (TEP_NEITHER, "P_NEITHER TEP off but tep_details leaked"),
        ]:
            assert hidden not in packed, f"stored-but-disabled detail leaked: {why}"

        # ---- Per-row gating: the disabled flag keyword absent from that cell ----
        w_dnacpr = window(packed, NAME_DNACPR)
        assert f"DNACPR:{DNACPR_ONLY}" in w_dnacpr, "P_DNACPR row missing its DNACPR value"
        assert "TEP:" not in w_dnacpr, "P_DNACPR row should not render any TEP value"

        w_tep = window(packed, NAME_TEP)
        assert f"TEP:{TEP_ONLY}" in w_tep, "P_TEP row missing its TEP value"
        assert "DNACPR:" not in w_tep, "P_TEP row should not render any DNACPR value"

        # ---- Neither on: flags cell collapses to em-dash placeholder ----
        w_neither = window(packed, NAME_NEITHER)
        assert "DNACPR" not in w_neither, "P_NEITHER row should not render DNACPR"
        assert "TEP:" not in w_neither, "P_NEITHER row should not render TEP"
        assert PLACEHOLDER in w_neither, "P_NEITHER row missing em-dash placeholder in flags cell"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: DNACPR/TEP sections render (with details) only when their "
            "toggle is enabled; stored-but-disabled details never leak into the PDF"
        )
        return 0
    finally:
        cleanup(patient_ids, user_id)


if __name__ == "__main__":
    sys.exit(main())
