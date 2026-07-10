"""
Regression test: after a patient's investigations are UPDATED (each key record
edited to a newer finding + result time), the exported handover PDF must show
only the current values — NONE of the superseded (pre-update) timestamps may
appear anywhere in the investigations section.

This guards against a stale-render regression where an edited investigation's
old result_at could linger in the PDF (e.g. cached row, wrong sort, or the old
value bleeding into the "most recent" line). The investigations column renders
the newest result per category via mostRecentInvestigation(), formatted with
fmtDateTime() as "dd/mm/yyyy, HH:MM" (src/lib/handover-pdf.ts). The render
timezone is pinned so timestamp strings are deterministic.

Steps:
  1. Seed one patient with Bloods / CXR / CT chest, each at an INITIAL time.
  2. UPDATE each record in place (PATCH) to a NEWER finding + result_at,
     simulating a clinician correcting/refreshing the result.
  3. Sign in, export + download the handover PDF from the real UI.
  4. Assert every UPDATED finding + its timestamp appears, and that NONE of the
     superseded pre-update findings or timestamps appear anywhere in the PDF.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-updated-no-superseded-timestamps.e2e.py
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

MARKER = f"E2EPDFUPD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "U.P.D."

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]
now = datetime.now(timezone.utc)

# Per category: initial (superseded) vs updated (current) finding + result_at.
CATEGORIES = {
    "Bloods": {
        "old_find": f"BOLD{SUFFIX}",
        "new_find": f"BNEW{SUFFIX}",
        "old_at": now - timedelta(days=2, hours=3),
        "new_at": now - timedelta(hours=1),
    },
    "CXR": {
        "old_find": f"XOLD{SUFFIX}",
        "new_find": f"XNEW{SUFFIX}",
        "old_at": now - timedelta(days=1, hours=7),
        "new_at": now - timedelta(hours=4),
    },
    "CT chest": {
        "old_find": f"COLD{SUFFIX}",
        "new_find": f"CNEW{SUFFIX}",
        "old_at": now - timedelta(days=3, hours=1),
        "new_at": now - timedelta(hours=6),
    },
}


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
            "age": 65,
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
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": result_at,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def update_investigation(inv_id, findings, result_at):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/investigations?id=eq.{inv_id}",
        headers=admin_headers(),
        json={"findings": findings, "result_at": result_at},
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

        # Seed initial records, then UPDATE each in place to a newer value/time.
        for category, spec in CATEGORIES.items():
            inv_id = add_investigation(patient_id, category, spec["old_find"], iso(spec["old_at"]))
            update_investigation(inv_id, spec["new_find"], iso(spec["new_at"]))

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

        _, packed = extract_pdf_text(pdf_path)

        # Collect the set of current (kept) timestamps so we never flag a
        # superseded stamp that legitimately coincides with a current one.
        kept_stamps = {packed_datetime(spec["new_at"]) for spec in CATEGORIES.values()}

        for category, spec in CATEGORIES.items():
            new_stamp = packed_datetime(spec["new_at"])
            assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", new_stamp), (
                f"{category}: expected stamp '{new_stamp}' malformed (test bug)"
            )
            label = "".join(category.split())  # e.g. "CTchest"

            # ---- Updated finding + timestamp present on this category's line ----
            assert f"{label}:{spec['new_find']}({new_stamp})" in packed, (
                f"{category}: updated finding '{spec['new_find']}' at '{new_stamp}' "
                f"missing from PDF"
            )

            # ---- Superseded finding must be gone ----
            assert spec["old_find"] not in packed, (
                f"{category}: superseded finding '{spec['old_find']}' still in PDF"
            )

            # ---- Superseded timestamp must be gone (unless it equals a kept one) ----
            old_stamp = packed_datetime(spec["old_at"])
            if old_stamp not in kept_stamps:
                assert old_stamp not in packed, (
                    f"{category}: superseded timestamp '{old_stamp}' still appears in the "
                    f"investigations section — stale-render regression"
                )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: updated investigations render current values only; no superseded "
            "findings or timestamps remain in the handover PDF"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
