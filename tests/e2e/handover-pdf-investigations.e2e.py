"""
End-to-end test: the exported handover PDF contains the "most recent" key
investigation snapshots — newest Bloods, newest CXR, newest CT chest — as text.

The handover sheet's "Most recent investigations" column renders one line per
key category (Bloods / CXR / CT chest) with the NEWEST finding per category.
This test seeds a patient with multiple results (including an older + newer
Bloods) then drives the real UI export and inspects the PDF text:

  1. Restore a clinician session and open /patients.
  2. Preview PDF -> Download PDF, capturing the actual download.
  3. Extract the PDF text (pdftotext) and assert it contains:
       - the newest Bloods finding (and NOT the superseded older one)
       - the newest CXR finding
       - the newest CT chest finding
       - the Bloods / CXR / CT chest category labels

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-investigations.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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

MARKER = f"E2EPDFINV{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "I.N.V."

# The PDF renders result timestamps with fmtDateTime() (src/lib/icu.ts), i.e.
# toLocaleString("en-GB", {day,month,year,hour,minute, hour12:false}) which
# yields "dd/mm/yyyy, HH:MM" in the RENDERING environment's timezone. We pin the
# browser timezone so the expected strings are deterministic across machines.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

# Short single-token findings (no spaces, kept short so they never wrap inside
# the narrow investigations column). Uniqueness via a short suffix keeps the
# assertions specific to this patient's rows.
SUFFIX = str(int(time.time()))[-6:]
BLOODS_OLD = f"BOLD{SUFFIX}"
BLOODS_NEW = f"BNEW{SUFFIX}"
CXR_NEW = f"CXNEW{SUFFIX}"
CT_NEW = f"CTNEW{SUFFIX}"

now = datetime.now(timezone.utc)

# Result timestamps for each seeded investigation (UTC). Kept as named
# constants so the test can assert the PDF shows the newest entry's timestamp
# and NOT the superseded one.
BLOODS_OLD_AT = now - timedelta(days=2)
BLOODS_NEW_AT = now - timedelta(hours=1)
CXR_NEW_AT = now - timedelta(hours=3)
CT_NEW_AT = now - timedelta(hours=5)


def fmt_datetime_engb(dt_utc):
    """Mirror fmtDateTime(): en-GB 'dd/mm/yyyy, HH:MM' in the pinned timezone."""
    local = dt_utc.astimezone(TZ)
    return local.strftime("%d/%m/%Y, %H:%M")


def packed_datetime(dt_utc):
    """Same as fmt_datetime_engb but whitespace-stripped to match packed text."""
    return "".join(fmt_datetime_engb(dt_utc).split())


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
            "age": 66,
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
        # investigations cascade via FK, but delete explicitly to be safe.
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
    # Collapse whitespace so wrapped table cells don't hide our single-token markers.
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # Two Bloods results: an OLDER one that must be superseded, and a NEWER
        # one that must appear as the "most recent" Bloods line.
        add_investigation(patient_id, "Bloods", BLOODS_OLD, iso(BLOODS_OLD_AT))
        add_investigation(patient_id, "Bloods", BLOODS_NEW, iso(BLOODS_NEW_AT))
        add_investigation(patient_id, "CXR", CXR_NEW, iso(CXR_NEW_AT))
        add_investigation(patient_id, "CT chest", CT_NEW, iso(CT_NEW_AT))

        session = sign_in(email)

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

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # Make sure our seeded patient is on the board before exporting.
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

        # ---- Category labels present ----
        for label in ("Bloods", "CXR", "CT chest"):
            assert label in raw_text, f"handover PDF missing '{label}' investigation section"

        # ---- Most-recent findings present ----
        assert BLOODS_NEW in packed, "newest Bloods finding missing from handover PDF"
        assert CXR_NEW in packed, "newest CXR finding missing from handover PDF"
        assert CT_NEW in packed, "newest CT chest finding missing from handover PDF"

        # ---- Superseded older Bloods must NOT appear (proves 'most recent') ----
        assert BLOODS_OLD not in packed, (
            "older Bloods finding leaked into handover PDF — 'most recent' selection is wrong"
        )

        # ---- Displayed timestamps are correctly formatted AND belong to the
        #      most recent entry for each category ----
        expected_new = {
            "Bloods": (BLOODS_NEW, BLOODS_NEW_AT),
            "CXR": (CXR_NEW, CXR_NEW_AT),
            "CT chest": (CT_NEW, CT_NEW_AT),
        }
        # In the packed text each key line reads "<Category>:<finding>(<dd/mm/yyyy,HH:MM>)".
        for category, (finding, at) in expected_new.items():
            stamp = packed_datetime(at)
            # Timestamp string must be present and in the exact dd/mm/yyyy,HH:MM shape.
            assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", stamp), (
                f"expected timestamp '{stamp}' is not in dd/mm/yyyy,HH:MM form (test bug)"
            )
            assert stamp in packed, (
                f"{category}: newest result timestamp '{stamp}' missing/mis-formatted in PDF"
            )
            # The timestamp must be directly attached to THIS category's newest
            # finding — i.e. "<finding>(<stamp>)" — proving it belongs to the
            # most recent entry, not a stray/older one.
            pair = f"{finding}({stamp})"
            assert pair in packed, (
                f"{category}: timestamp not paired with its newest finding; "
                f"expected '{pair}' in packed PDF text"
            )

        # ---- The superseded older Bloods timestamp must NOT appear ----
        old_stamp = packed_datetime(BLOODS_OLD_AT)
        # Guard: only meaningful if the old stamp differs from every kept stamp.
        kept_stamps = {packed_datetime(at) for _, at in expected_new.values()}
        if old_stamp not in kept_stamps:
            assert old_stamp not in packed, (
                f"superseded Bloods timestamp '{old_stamp}' leaked into PDF — "
                f"'most recent' timestamp selection is wrong"
            )

        # Cleanup the artifact.
        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: handover PDF shows newest Bloods, CXR, CT chest with correctly "
            "formatted (dd/mm/yyyy, HH:MM) most-recent timestamps"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
