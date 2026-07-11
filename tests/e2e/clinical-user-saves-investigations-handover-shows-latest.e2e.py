"""
End-to-end test: a signed-in CLINICAL user SAVES multiple Bloods / CXR / CT
chest investigations for a patient (through the app's real Add-result RPC), and
the handover view's "most recent investigations" summary shows ONLY the newest
result per category — superseded results never appear.

This exercises the full write→render path:
  - Results are saved via the genuine TanStack server-function RPC
    (addInvestigation in src/lib/investigations.functions.ts) — the same call
    the Add-result dialog issues, running as the signed-in clinician (RLS on).
  - The handover summary is produced by investigations() ->
    mostRecentInvestigation() over
    RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"]
    (src/lib/handover-recency.ts), surfaced on the printable handover preview
    (src/routes/_authenticated/patients.handover-preview.tsx).

For each category two results are saved with distinct findings — an OLDER one
and a NEWER one — and the OLDER is deliberately saved AFTER the NEWER, so a
naive "last saved wins" would pick the wrong (stale) result. The exported
handover PDF must still show only the newest per category, in the fixed section
order Bloods -> CXR -> CT chest.

Steps:
  1. Seed an admitted patient (admin API) so it appears on the handover sheet.
  2. Sign in as a throwaway clinician.
  3. Save 2 results per category via addInvestigation (newest first, then the
     back-dated older one).
  4. Open Preview PDF, download it, extract the text.
  5. Assert each category shows only its newest findings + timestamp, in order,
     and every superseded finding is absent.

Throwaway clinician user + patient + investigation rows are created and cleaned
up via the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/clinical-user-saves-investigations-handover-shows-latest.e2e.py
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
INV_MODULE = "/src/lib/investigations.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2ESVLAT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"SVL.{str(int(time.time()))[-4:]}"
HOSPITAL_NUMBER = f"MRN{str(int(time.time()))[-6:]}"

CAT_BLOODS = "Bloods"
CAT_CXR = "CXR"
CAT_CT = "CT chest"

NOW = datetime.now(timezone.utc).replace(microsecond=0)

# Per-category latest/stale findings (unique so we can assert exactly which one
# the summary shows) and their recorded times (latest more recent than stale).
LATEST_FINDINGS = {
    CAT_BLOODS: f"Bloods latest lactate 4.1 {MARKER}",
    CAT_CXR: f"CXR latest right basal consolidation {MARKER}",
    CAT_CT: f"CT chest latest segmental PE {MARKER}",
}
STALE_FINDINGS = {
    CAT_BLOODS: f"Bloods stale lactate 1.1 {MARKER}",
    CAT_CXR: f"CXR stale clear lung fields {MARKER}",
    CAT_CT: f"CT chest stale unremarkable {MARKER}",
}
LATEST_HOURS_AGO = {CAT_BLOODS: 2, CAT_CXR: 1, CAT_CT: 3}
STALE_HOURS_AGO = {CAT_BLOODS: 10, CAT_CXR: 6, CAT_CT: 9}

# Save order: every NEWEST first, then every (back-dated) STALE — so a naive
# "last saved wins" would select the stale result.
SAVE_SEQUENCE = (
    [(cat, LATEST_FINDINGS[cat], LATEST_HOURS_AGO[cat]) for cat in
     (CAT_BLOODS, CAT_CXR, CAT_CT)]
    + [(cat, STALE_FINDINGS[cat], STALE_HOURS_AGO[cat]) for cat in
       (CAT_BLOODS, CAT_CXR, CAT_CT)]
)


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
            "hospital_number": HOSPITAL_NUMBER,
            "current_admission": f"Admission note {MARKER}",
            "admission_date": NOW.date().isoformat(),
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


CALL_SERVER_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn({ data: arg.data });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def add_result(page, patient_id, category, findings, hours_ago):
    result_at = (NOW - timedelta(hours=hours_ago)).isoformat()
    r = page.evaluate(
        CALL_SERVER_FN,
        {
            "module": INV_MODULE,
            "name": "addInvestigation",
            "data": {
                "patient_id": patient_id,
                "category": category,
                "findings": findings,
                "result_at": result_at,
            },
        },
    )
    assert r["ok"], f"saving {category} '{findings}' failed: {r.get('error')}"


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

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- Save multiple results per category as the clinician ----
            for category, findings, hours_ago in SAVE_SEQUENCE:
                add_result(page, patient_id, category, findings, hours_ago)
                time.sleep(0.05)  # distinct created_at, mirroring save order

            # Reload so the board's patient query refetches with the newly
            # saved investigations embedded (the preview renders from that data).
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- Open the handover preview and export the PDF ----
            # Filter the board to just this patient by hospital number, so the
            # export validates/renders only our record (the shared board may
            # hold other active patients missing critical fields).
            search = page.get_by_placeholder("Search initials or hospital no.…")
            search.fill(HOSPITAL_NUMBER)
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=10000
            )

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
        assert packed(PATIENT_NAME) in packed_text, (
            "patient missing from PDF (blank/failed export?)"
        )

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

        # Each category shows ONLY its newest findings + timestamp.
        for cat in (CAT_BLOODS, CAT_CXR, CAT_CT):
            latest = LATEST_FINDINGS[cat]
            assert packed(latest) in packed_text, (
                f"{cat} newest findings missing from handover: {latest!r}"
            )
            label_start = packed_text.find(packed(f"{cat}:"))
            cell = packed_text[label_start: label_start + 260]
            assert packed(latest) in cell, (
                f"{cat} cell does not carry its newest findings; cell={cell!r}"
            )
            stamp = (NOW - timedelta(hours=LATEST_HOURS_AGO[cat])).strftime("%d/%m/%Y")
            assert packed(stamp) in cell, (
                f"{cat} cell missing its newest timestamp; cell={cell!r}"
            )

        # No superseded (stale) findings may appear anywhere in the summary.
        for cat, stale in STALE_FINDINGS.items():
            assert packed(stale) not in packed_text, (
                f"superseded {cat} findings leaked into handover: {stale!r}"
            )

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: clinician saved multiple Bloods/CXR/CT results; the handover "
            "summary shows only the most recent per category (stale results "
            "excluded), in fixed section order"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
