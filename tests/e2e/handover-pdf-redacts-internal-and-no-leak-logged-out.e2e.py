"""
End-to-end test: the exported handover PDF omits internal-only fields, and no
patient detail is obtainable while logged out.

Two guarantees, both exercised against real app surfaces:

  A. REDACTION (logged in) — export the real handover PDF for a patient seeded
     with sentinel values in BOTH visible and internal-only fields, then assert:
       * visible clinical fields ARE present (control: proves we exported the
         right patient) — full name, management, PMH, DNACPR details;
       * internal-only fields are OMITTED — the patient's DB UUID, the
         created_by / updated_by user ids, the raw created_at / updated_at
         timestamps, the dnacpr_date, and (because the patient is still
         admitted) the discharge_date / discharge_destination / date_of_death.
     The handover sheet renders a fixed whitelist of columns
     (src/lib/handover-pdf.ts), so these identifiers and non-rendered dates must
     never appear in the extracted PDF text.

  B. NO LEAK (logged out) — with no session:
       * deep-links to /patients and /patients/<id> redirect to /auth and never
         render the patient's name or the export control;
       * the raw server functions that feed the export (listPatients /
         getPatient) reject unauthenticated calls and return zero patient data,
         and a bare malformed request is refused too.

Throwaway admin user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-redacts-internal-and-no-leak-logged-out.e2e.py
Exits 0 on success, non-zero on failure.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime
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

MARKER = f"REDACT{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"{MARKER}-REDACTME"

# Visible clinical fields (MUST appear in the PDF).
MGMT = f"{MARKER}-MGMT-VISIBLE"
PMH = f"{MARKER}-PMH-VISIBLE"
DNACPR_DETAILS = f"{MARKER}-DNACPR-VISIBLE"

# Internal-only / non-rendered fields (MUST NOT appear in the PDF).
# The patient is admitted, so discharge_* and date_of_death are not rendered.
DISCHARGE_DEST = f"{MARKER}-DEST-INTERNAL"
DISCHARGE_DATE = "2023-03-07"       # 07/03/2023
DATE_OF_DEATH = "2022-11-13"        # 13/11/2022
DNACPR_DATE = "2021-06-22"          # 22/06/2021

# Raw server-fn transport wiring (matches pdf-export-requires-auth-401.e2e.py).
FUNCTIONS_FILE = "/src/lib/patients.functions.ts?tss-serverfn-split"
SERVER_FN_HEADERS = {
    "accept": "application/x-tss-framed, application/x-ndjson, application/json",
    "x-tsr-serverfn": "true",
}
LIST_PAYLOAD = {"t": {"t": 10, "i": 0, "p": {"k": ["data"], "v": [
    {"t": 10, "i": 1, "p": {"k": [], "v": []}, "o": 0}]}, "o": 0}, "f": 63, "m": []}


def get_payload(patient_id):
    return {"t": {"t": 10, "i": 0, "p": {"k": ["data"], "v": [
        {"t": 10, "i": 1, "p": {"k": ["id"], "v": [{"t": 1, "s": patient_id}]}, "o": 0}]},
        "o": 0}, "f": 63, "m": []}


def server_fn_url(export_name, payload):
    fn_id = base64.urlsafe_b64encode(
        json.dumps({"file": FUNCTIONS_FILE, "export": export_name},
                   separators=(",", ":")).encode()
    ).decode().rstrip("=")
    qs = urllib.parse.urlencode({"payload": json.dumps(payload, separators=(",", ":"))})
    return f"{BASE_URL}/_serverFn/{fn_id}?{qs}"


def fmt_uk(iso_date):
    d = datetime.strptime(iso_date, "%Y-%m-%d")
    return d.strftime("%d/%m/%Y")


def packed(s):
    return "".join(s.split())


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
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
        json={"user_id": uid, "role": "admin"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient(owner_uid):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "3",
            "status": "admitted",
            "admission_date": datetime.utcnow().date().isoformat(),
            "past_medical_history": PMH,
            "current_management": MGMT,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_DETAILS,
            "dnacpr_date": DNACPR_DATE,
            # internal / not-rendered-in-this-view fields:
            "discharge_destination": DISCHARGE_DEST,
            "discharge_date": DISCHARGE_DATE,
            "date_of_death": DATE_OF_DEATH,
            "created_by": owner_uid,
            "updated_by": owner_uid,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(user_id, patient_id):
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
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout


def leaks(text, patient_id):
    t = (text or "")
    return (patient_id in t) or (MARKER in t) or (PATIENT_NAME in t)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_admin_user()
        row = create_patient(user_id)
        patient_id = row["id"]
        session = sign_in(email)

        # ============ A. REDACTION — export while logged in ============
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
                timezone_id="Europe/London",
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()
            dlg = page.get_by_role("dialog")
            download_btn = dlg.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            dl_info.value.save_as(str(pdf_path))

            browser.close()

        raw_text = extract_pdf_text(pdf_path)
        packed_text = packed(raw_text)

        # Visible clinical fields must be present (proves we exported this patient).
        for token in (PATIENT_NAME, MGMT, PMH, DNACPR_DETAILS):
            assert packed(token) in packed_text, (
                f"expected visible field '{token}' missing from the PDF — "
                f"redaction test cannot trust its negative assertions"
            )
        print("OK  visible clinical fields render in the PDF")

        # Internal-only identifiers must be OMITTED.
        internal_ids = {
            "patient id (uuid)": row["id"],
            "created_by (uuid)": row.get("created_by") or "",
            "updated_by (uuid)": row.get("updated_by") or "",
            "created_at (raw ISO)": row.get("created_at") or "",
            "updated_at (raw ISO)": row.get("updated_at") or "",
            "discharge_destination": DISCHARGE_DEST,
        }
        for label, value in internal_ids.items():
            if not value:
                continue
            assert packed(value) not in packed_text, (
                f"internal field leaked into PDF: {label} = {value!r}"
            )
        print("OK  internal identifiers (ids, created/updated by & at, discharge dest) omitted")

        # Non-rendered dates must be OMITTED (neither UK-formatted nor raw ISO).
        for label, iso in (
            ("dnacpr_date", DNACPR_DATE),
            ("discharge_date", DISCHARGE_DATE),
            ("date_of_death", DATE_OF_DEATH),
        ):
            for form in (fmt_uk(iso), iso):
                assert packed(form) not in packed_text, (
                    f"non-rendered date leaked into PDF: {label} as {form!r}"
                )
        print("OK  non-rendered dates (dnacpr/discharge/death) omitted")

        # ============ B. NO LEAK — logged out ============
        list_url = server_fn_url("listPatients_createServerFn_handler", LIST_PAYLOAD)
        get_url = server_fn_url("getPatient_createServerFn_handler", get_payload(patient_id))
        for label, url in (("listPatients", list_url), ("getPatient", get_url)):
            r = requests.get(url, headers=SERVER_FN_HEADERS, timeout=30)
            assert "unauthor" in r.text.lower(), (
                f"unauth {label} was not rejected (status {r.status_code}): {r.text[:200]!r}"
            )
            assert not leaks(r.text, patient_id), (
                f"unauth {label} leaked patient data: {r.text[:300]!r}"
            )
        r_bare = requests.get(list_url, timeout=30)
        assert not leaks(r_bare.text, patient_id), (
            f"bare unauthenticated request leaked patient data: {r_bare.text[:300]!r}"
        )
        print("OK  export data endpoints reject logged-out callers with no data leak")

        # Logged-out UI: deep links redirect to /auth and never show details.
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()
            for path in ("/patients", f"/patients/{patient_id}"):
                page.goto(f"{BASE_URL}{path}", wait_until="domcontentloaded")
                page.wait_for_load_state("networkidle")
                page.wait_for_url("**/auth**", timeout=15000)
                body = page.inner_text("body")
                assert not leaks(body, patient_id), (
                    f"logged-out page {path} leaked patient detail: "
                    f"{[t for t in (PATIENT_NAME, MARKER, patient_id) if t in body]}"
                )
                assert page.get_by_role("button", name="Preview PDF").count() == 0, (
                    f"export control rendered while logged out on {path}"
                )
            page.screenshot(path=str(SCREENSHOTS / f"redact_{MARKER}_loggedout.png"))
            browser.close()
        print("OK  logged-out deep links redirect to /auth; no patient detail, no export control")

        print("\nPASS: PDF redacts internal-only fields and no patient data leaks when logged out.")
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
