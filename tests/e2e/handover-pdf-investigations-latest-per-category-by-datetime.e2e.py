"""
End-to-end test: the handover PDF "most recent investigations" column selects
the newest result PER CATEGORY strictly by recorded `result_at` datetime, not
by insertion / received order — even when categories have overlapping dates.

The column is built by investigations() -> mostRecentInvestigation() over
RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] in
src/lib/handover-pdf.ts, choosing the newest result_at for each category.

Three categories are seeded with two results each. Their timestamps OVERLAP
across categories (interleaved), and rows are inserted ONE AT A TIME in a
scramble where each category's STALE result is inserted AFTER its LATEST — so a
naive "last inserted wins" would pick the wrong (older) result. Sequential
single-row inserts make the DB's natural (ctid) order follow the scramble, so
the client receives rows in insertion order — yet the PDF must pick by datetime.

Timestamps (overlapping / interleaved across categories):
  CXR    latest = now - 1h     CXR    stale = now - 5h
  Bloods latest = now - 2h     Bloods stale = now - 10h
  CT     latest = now - 3h     CT     stale = now - 8h

Assertions on the exported PDF:
  - Each category shows its LATEST findings + the matching timestamp.
  - Every STALE finding is absent (no superseded result surfaces).
  - Category order remains Bloods -> CXR -> CT chest (fixed section order).

Throwaway clinician user + patient + investigation rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-investigations-latest-per-category-by-datetime.e2e.py
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

MARKER = f"E2EINVDT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"INVDT.{str(int(time.time()))[-4:]}"

CAT_BLOODS = "Bloods"
CAT_CXR = "CXR"
CAT_CT = "CT chest"

BLOODS_LATEST = f"Bloods latest lactate 4.1 {MARKER}"
BLOODS_STALE = f"Bloods stale lactate 1.2 {MARKER}"
CXR_LATEST = f"CXR latest right effusion {MARKER}"
CXR_STALE = f"CXR stale clear {MARKER}"
CT_LATEST = f"CT chest latest PE segmental {MARKER}"
CT_STALE = f"CT chest stale unremarkable {MARKER}"

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def at(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).isoformat()


# Per-category (latest, stale) with overlapping/interleaved timestamps.
LATEST_AT = {CAT_BLOODS: 2, CAT_CXR: 1, CAT_CT: 3}
LATEST_FINDINGS = {CAT_BLOODS: BLOODS_LATEST, CAT_CXR: CXR_LATEST, CAT_CT: CT_LATEST}

# Deliberately scrambled insertion order: each category's STALE is inserted
# AFTER its LATEST, so "last inserted wins" would choose the wrong result.
INSERT_SEQUENCE = [
    (CAT_BLOODS, BLOODS_LATEST, at(2)),
    (CAT_CXR, CXR_LATEST, at(1)),
    (CAT_CT, CT_LATEST, at(3)),
    (CAT_BLOODS, BLOODS_STALE, at(10)),
    (CAT_CXR, CXR_STALE, at(5)),
    (CAT_CT, CT_STALE, at(8)),
]

STALE_FINDINGS = [BLOODS_STALE, CXR_STALE, CT_STALE]


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
            "age": 54,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "17",
            "status": "admitted",
            "admission_date": NOW.date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_investigations(patient_id):
    # Insert one row at a time so the DB's natural row order follows the
    # scrambled insertion sequence (proving the PDF reorders by datetime).
    for category, findings, result_at in INSERT_SEQUENCE:
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
        time.sleep(0.05)  # distinct created_at, mirroring the sequence


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
    return out.stdout, packed(out.stdout)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_investigations(patient_id)
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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            dlg = page.get_by_role("dialog")
            download_btn = dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)

        assert packed(PATIENT_NAME) in packed_text, "patient missing from PDF (blank/failed export?)"

        # Fixed section order: Bloods -> CXR -> CT chest.
        pos_bloods = packed_text.find(packed(f"{CAT_BLOODS}:"))
        pos_cxr = packed_text.find(packed(f"{CAT_CXR}:"))
        pos_ct = packed_text.find(packed(f"{CAT_CT}:"))
        assert -1 not in (pos_bloods, pos_cxr, pos_ct), (
            f"a category label is missing; bloods={pos_bloods} cxr={pos_cxr} ct={pos_ct}"
        )
        assert pos_bloods < pos_cxr < pos_ct, (
            "investigation categories out of order; expected Bloods -> CXR -> CT chest"
        )

        # Each category shows its datetime-newest findings; stale absent.
        for cat in (CAT_BLOODS, CAT_CXR, CAT_CT):
            latest = LATEST_FINDINGS[cat]
            assert packed(latest) in packed_text, f"{cat} latest findings missing from PDF: {latest!r}"

            # The latest findings + its timestamp sit within that category's cell.
            label_start = packed_text.find(packed(f"{cat}:"))
            cell = packed_text[label_start: label_start + 220]
            assert packed(latest) in cell, (
                f"{cat} cell does not carry its latest findings; cell={cell!r}"
            )
            stamp = (NOW - timedelta(hours=LATEST_AT[cat])).strftime("%d/%m/%Y")
            assert packed(stamp) in cell, f"{cat} cell missing its latest timestamp; cell={cell!r}"

        for findings in STALE_FINDINGS:
            assert packed(findings) not in packed_text, (
                f"superseded findings leaked into PDF: {findings!r}"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: each investigation category shows its most recent result by "
            "recorded datetime (overlapping dates), independent of insertion order"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
