"""
End-to-end test: microbiology results with MISSING / NULL datetime fields
(`result_at`) are handled safely by the handover PDF — either excluded in
favour of a properly timestamped result, or, when they are the only data,
rendered deterministically with no fabricated timestamp and never surfacing
older findings.

Why the datetime is nulled at the network layer, not in the DB:
`microbiology_results.result_at` is NOT NULL with a `now()` default, so a null
datetime cannot exist in the database. The place null/missing datetimes must be
tolerated is the CLIENT PDF generator (microbiology() ->
latestMicrobiologyPerSpecimen() in src/lib/handover-pdf.ts, which sorts via
parseTime() where a missing/invalid date is NEGATIVE_INFINITY / oldest). This
test therefore seeds real rows, then intercepts the client's patient fetch and
nulls `result_at` on the target rows — delivering exactly the shape the PDF
code must survive — while still driving the real export UI end to end.

Two specimens are exercised for one patient:

  A) Blood culture — a NULL-dated stale result AND a properly dated latest
     result. Expectation: the PDF shows the DATED latest findings and EXCLUDES
     the null-dated stale findings (no older data surfaced).

  B) Urine — a SINGLE null-dated result only. Expectation: the PDF renders that
     result deterministically (it is the only datum), with NO fabricated
     date/time attached to its line.

Assertions:
  - Blood culture latest (dated) findings present; its null-dated stale
    findings absent.
  - Urine null-dated findings present, and the Urine line carries no
    "(dd/mm/yyyy" timestamp fragment.
  - The patient still exports cleanly (no crash / blank export).

Throwaway clinician user + patient + microbiology rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-microbiology-null-datetime.e2e.py
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

MARKER = f"E2EMICNULL{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"MICNULL.{str(int(time.time()))[-4:]}"

SPEC_A = "Blood culture"
SPEC_B = "Urine"

A_NULL_STALE = f"Blood culture null-dated stale no growth {MARKER}"
A_DATED_LATEST = f"Blood culture dated latest Klebsiella {MARKER}"
B_NULL_ONLY = f"Urine null-dated only mixed growth {MARKER}"

DATED_AT = (datetime.now(timezone.utc) - timedelta(hours=3)).replace(microsecond=0)
# Placeholder seed dates (overwritten to null at the network layer for the
# rows we want null). The stale Blood-culture row is seeded OLDER so that even
# if interception were skipped the dated-latest still wins — the test remains
# meaningful, and interception makes the null path explicit.
SEED_STALE_AT = (datetime.now(timezone.utc) - timedelta(days=2)).replace(microsecond=0)

MICRO_ROWS = [
    {"specimen_type": SPEC_A, "findings": A_NULL_STALE, "result_at": SEED_STALE_AT.isoformat()},
    {"specimen_type": SPEC_A, "findings": A_DATED_LATEST, "result_at": DATED_AT.isoformat()},
    {"specimen_type": SPEC_B, "findings": B_NULL_ONLY, "result_at": SEED_STALE_AT.isoformat()},
]

# Findings whose result_at must be delivered to the client as null.
NULL_FINDINGS = {A_NULL_STALE, B_NULL_ONLY}


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
            "age": 63,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "12",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_microbiology(patient_id):
    rows = [{**m, "patient_id": patient_id} for m in MICRO_ROWS]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json=rows,
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
            f"{SUPABASE_URL}/rest/v1/microbiology_results?patient_id=eq.{patient_id}",
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


def null_out_datetimes(payload):
    """Recursively set result_at = None on any target microbiology row.

    The patients data arrives through the TanStack `listPatients` server
    function, whose JSON envelope shape is an implementation detail. Walk the
    whole structure and null `result_at` on every dict whose `findings` is one
    of the target null rows, wherever it is nested.
    """
    mutated = 0

    def walk(node):
        nonlocal mutated
        if isinstance(node, dict):
            if node.get("findings") in NULL_FINDINGS and node.get("result_at") is not None:
                node["result_at"] = None
                mutated += 1
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(payload)
    return mutated



def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_microbiology(patient_id)
        session = sign_in(email)

        intercept_stats = {"patient_responses": 0, "rows_nulled": 0}

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )

            def is_list_patients(url):
                # The server fn id is a base64 segment after /_serverFn/.
                try:
                    seg = url.split("/_serverFn/", 1)[1].split("?", 1)[0].split("/", 1)[0]
                    import base64 as _b64
                    decoded = _b64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)).decode("utf-8", "ignore")
                    return "listPatients" in decoded
                except Exception:
                    return False

            def handle_route(route):
                url = route.request.url
                # The patients list is delivered via the listPatients server fn.
                if "/_serverFn/" in url and is_list_patients(url):
                    resp = route.fetch()
                    try:
                        data = resp.json()
                    except Exception:
                        route.fulfill(response=resp)
                        return
                    n = null_out_datetimes(data)
                    if n:
                        intercept_stats["patient_responses"] += 1
                        intercept_stats["rows_nulled"] += n
                    route.fulfill(
                        response=resp,
                        body=json.dumps(data),
                        headers={**resp.headers, "content-type": "application/json"},
                    )
                    return
                route.continue_()

            context.route("**/_serverFn/**", handle_route)

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

        # Confirm the interception actually delivered null datetimes to the client.
        assert intercept_stats["patient_responses"] > 0, (
            "patients fetch with embedded microbiology_results was never intercepted"
        )
        assert intercept_stats["rows_nulled"] >= 2, (
            f"expected to null >=2 microbiology datetimes, nulled "
            f"{intercept_stats['rows_nulled']}"
        )

        raw_text, packed_text = extract_pdf_text(pdf_path)

        # Clean export: patient present.
        assert packed(PATIENT_NAME) in packed_text, "patient missing from PDF (blank/failed export?)"

        # A) Dated latest wins; null-dated stale for the SAME specimen excluded.
        assert packed(A_DATED_LATEST) in packed_text, (
            "dated latest Blood culture findings missing from PDF"
        )
        assert packed(A_NULL_STALE) not in packed_text, (
            "null-dated stale Blood culture findings leaked into the PDF"
        )
        assert packed(DATED_AT.strftime("%d/%m/%Y")) in packed_text, (
            "dated latest Blood culture timestamp not rendered"
        )

        # B) Null-only specimen falls back deterministically to its one result,
        #    rendered WITHOUT a fabricated timestamp on that line.
        assert packed(B_NULL_ONLY) in packed_text, (
            "null-dated Urine result was not rendered (should fall back to it)"
        )
        b_idx = packed_text.find(packed(f"{SPEC_B}:"))
        assert b_idx != -1, "Urine specimen label missing from PDF"
        b_window = packed_text[b_idx:b_idx + 120]
        assert packed(B_NULL_ONLY) in b_window, (
            f"Urine line does not carry its null-dated findings; window={b_window!r}"
        )
        assert not re.search(r"\(\d{2}/\d{2}/\d{4}", b_window), (
            f"a fabricated timestamp was attached to the null-dated Urine line; window={b_window!r}"
        )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: null/missing microbiology datetimes are excluded when a dated "
            "result exists, and fall back deterministically (no fabricated "
            "timestamp, no older findings) when they are the only data"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
