"""
End-to-end test: when a patient has ONLY Bloods investigations (no CXR, no
CT chest), the handover PDF renders the Bloods key line with its correctly
formatted timestamp, and the CXR and CT chest key lines show the em-dash
placeholder — with no stale value filling the empty slots.

The investigations column renders one line per key category
(RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] in
src/lib/handover-pdf.ts). A category with no matching investigation renders
"<Category>: —"; a present one renders "<Category>: <findings> (dd/mm/yyyy,
HH:MM)" via fmtDateTime(). The render timezone is pinned so the expected
timestamp string is deterministic.

Steps:
  1. Seed one patient with two Bloods results (older + newer) and NO CXR/CT.
  2. Sign in, export + download the handover PDF from the real UI.
  3. Assert: Bloods shows the NEWEST finding + its "dd/mm/yyyy, HH:MM" stamp;
     the superseded Bloods finding/stamp is absent; CXR and CT chest render
     "CXR: —" / "CT chest: —"; no stale value fills those slots.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-only-bloods-placeholders.e2e.py
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

MARKER = f"E2EPDFOB{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.B.L."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]
BLOODS_OLD = f"BOLD{SUFFIX}"
BLOODS_NEW = f"BNEW{SUFFIX}"

now = datetime.now(timezone.utc)
BLOODS_OLD_AT = now - timedelta(days=1)
BLOODS_NEW_AT = now - timedelta(hours=2)


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
    """Mirror fmtDateTime(): en-GB 'dd/mm/yyyy, HH:MM' in the pinned timezone."""
    return dt_utc.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


def packed_datetime(dt_utc):
    return "".join(fmt_datetime_engb(dt_utc).split())


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
            "age": 62,
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
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "category": category,
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


def cleanup(patient_id, user_id):
    if patient_id:
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
    return out.stdout, "".join(out.stdout.split())


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        # ONLY Bloods exist (older + newer). No CXR, no CT chest.
        add_investigation(patient_id, "Bloods", BLOODS_OLD, iso(BLOODS_OLD_AT))
        add_investigation(patient_id, "Bloods", BLOODS_NEW, iso(BLOODS_NEW_AT))

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

        # ---- All three key headings present ----
        for label in ("Bloods", "CXR", "CT chest"):
            assert label in raw_text, f"handover PDF missing '{label}' investigation heading"

        # ---- Bloods shows newest finding + correctly formatted timestamp ----
        new_stamp = packed_datetime(BLOODS_NEW_AT)
        assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", new_stamp), (
            f"expected timestamp '{new_stamp}' not in dd/mm/yyyy,HH:MM form (test bug)"
        )
        assert f"Bloods:{BLOODS_NEW}({new_stamp})" in packed, (
            f"Bloods line must show newest finding '{BLOODS_NEW}' at '{new_stamp}'; "
            f"packed around Bloods: {packed[packed.find('Bloods:'):packed.find('Bloods:')+50]!r}"
        )

        # ---- Superseded Bloods finding/stamp absent ----
        assert BLOODS_OLD not in packed, "superseded Bloods finding leaked into PDF"
        old_stamp = packed_datetime(BLOODS_OLD_AT)
        if old_stamp != new_stamp:
            assert old_stamp not in packed, f"superseded Bloods timestamp '{old_stamp}' leaked"

        # ---- CXR and CT chest render the em-dash placeholder ----
        assert "CXR:—" in packed, "CXR should render 'CXR: —' placeholder when absent"
        assert "CTchest:—" in packed, "CT chest should render 'CT chest: —' placeholder when absent"

        # ---- No stale value (the Bloods findings/stamps) wired to CXR/CT ----
        for stale in (BLOODS_NEW, BLOODS_OLD, new_stamp):
            assert f"CXR:{stale}" not in packed, f"stale value '{stale}' leaked into CXR slot"
            assert f"CTchest:{stale}" not in packed, f"stale value '{stale}' leaked into CT slot"

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: only-Bloods patient shows newest Bloods + formatted timestamp; "
            "CXR and CT chest render '—' placeholders with no stale values"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
