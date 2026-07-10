"""
End-to-end test: a full investigations + microbiology export shows ONLY the
latest entry per category/specimen, with NO superseded findings or timestamps
anywhere in the investigations/microbiology sections.

This is the combined regression case. One patient is seeded with:
  - Bloods, CXR, CT chest — each with an OLD and a NEW entry (updated in place
    by inserting a newer result_at), and
  - key microbiology across MULTIPLE specimens (Blood culture, Urine, Sputum),
    each with an OLD and a NEW result,

all inserted OUT OF ORDER. The real UI export is then driven and the PDF text
asserted:

  1. Each investigation category (Bloods/CXR/CT chest) shows ONLY its newest
     finding + correctly formatted 'dd/mm/yyyy, HH:MM' timestamp.
  2. Each microbiology specimen shows ONLY its newest finding + timestamp.
  3. NO superseded finding appears anywhere.
  4. NO superseded timestamp appears anywhere (unless it happens to coincide
     with a kept timestamp).

Browser timezone is pinned (Europe/London) for deterministic timestamps.
Throwaway clinician user + patient (+investigations +microbiology) are created
and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-all-categories-latest-only.e2e.py
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

MARKER = f"E2EPDFALL{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "A.L.L."

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)

SUFFIX = str(int(time.time()))[-6:]
_day = (datetime.now(TZ) - timedelta(days=1)).date()


def at_local(days_ago, hour, minute):
    d = _day - timedelta(days=days_ago)
    local = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc)


# Investigation categories: (old finding, old at) -> (new finding, new at).
INVESTIGATIONS = {
    "Bloods": [
        (f"BLDOLD{SUFFIX}", at_local(3, 8, 10)),
        (f"BLDNEW{SUFFIX}", at_local(0, 7, 30)),
    ],
    "CXR": [
        (f"CXROLD{SUFFIX}", at_local(2, 9, 45)),
        (f"CXRNEW{SUFFIX}", at_local(0, 12, 5)),
    ],
    "CT chest": [
        (f"CTCOLD{SUFFIX}", at_local(4, 15, 0)),
        (f"CTCNEW{SUFFIX}", at_local(0, 16, 40)),
    ],
}

# Microbiology specimens: old -> new per specimen.
MICRO = {
    "Blood culture": [
        (f"BCOLD{SUFFIX}", at_local(3, 6, 20)),
        (f"BCNEW{SUFFIX}", at_local(0, 10, 15)),
    ],
    "Urine": [
        (f"UROLD{SUFFIX}", at_local(2, 13, 50)),
        (f"URNEW{SUFFIX}", at_local(0, 18, 25)),
    ],
    "Sputum": [
        (f"SPOLD{SUFFIX}", at_local(5, 11, 5)),
        (f"SPNEW{SUFFIX}", at_local(0, 20, 35)),
    ],
}


def iso(dt):
    return dt.isoformat()


def fmt_datetime_engb(dt_utc):
    return dt_utc.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


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


def cleanup(patient_id, user_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
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

        # Insert everything OUT OF ORDER (new before old).
        for category, entries in INVESTIGATIONS.items():
            for finding, at in reversed(entries):
                add_investigation(patient_id, category, finding, iso(at))
        for specimen, entries in MICRO.items():
            for finding, at in reversed(entries):
                add_microbiology(patient_id, specimen, finding, iso(at))

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

        raw_text, packed_text = extract_pdf_text(pdf_path)

        assert "Most recent investigations" in raw_text, "missing investigations column header"
        assert "Key microbiology" in raw_text, "missing microbiology column header"

        # Collect kept timestamps first so a superseded stamp that coincides with
        # a kept one is not falsely flagged.
        kept_stamps = set()
        for entries in list(INVESTIGATIONS.values()) + list(MICRO.values()):
            kept_stamps.add(packed(fmt_datetime_engb(entries[-1][1])))

        # ---- 1. Each investigation category: newest finding + formatted stamp ----
        for category, entries in INVESTIGATIONS.items():
            new_find, new_at = entries[-1]
            new_stamp = fmt_datetime_engb(new_at)
            expected = packed(f"{category}: {new_find} ({new_stamp})")
            assert expected in packed_text, (
                f"{category}: expected latest '{category}: {new_find} ({new_stamp})' not found"
            )

        # ---- 2. Each microbiology specimen: newest finding + formatted stamp ----
        for specimen, entries in MICRO.items():
            new_find, new_at = entries[-1]
            new_stamp = fmt_datetime_engb(new_at)
            expected = packed(f"{specimen}: {new_find} ({new_stamp})")
            assert expected in packed_text, (
                f"{specimen}: expected latest '{specimen}: {new_find} ({new_stamp})' not found"
            )

        # ---- 3 & 4. No superseded finding or timestamp anywhere ----
        for label, entries in list(INVESTIGATIONS.items()) + list(MICRO.items()):
            for finding, at in entries[:-1]:
                assert packed(finding) not in packed_text, (
                    f"{label}: superseded finding '{finding}' leaked into PDF"
                )
                old_stamp = packed(fmt_datetime_engb(at))
                if old_stamp not in kept_stamps:
                    assert old_stamp not in packed_text, (
                        f"{label}: superseded timestamp '{fmt_datetime_engb(at)}' leaked into PDF"
                    )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: all investigation categories and microbiology specimens show "
            "only the latest entries; no superseded findings or timestamps leaked"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
