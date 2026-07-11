"""
End-to-end test: updating the escalation plan (TEP) and DNACPR decision on an
editable patient record is reflected in BOTH the in-app PDF preview AND the
downloaded handover PDF — each shows the latest saved values and none of the
pre-edit values.

This complements handover-pdf-edit-tep-dnacpr-latest.e2e.py (which only checks
the download) by additionally proving the embedded preview iframe renders the
same up-to-date PDF the user is about to download.

Steps:
  1. Seed a patient that ALREADY has a TEP + DNACPR entry (old details).
  2. Open the patient detail page, Edit, and in "Escalation & resuscitation"
     overwrite the TEP details and the DNACPR details with new values, Save.
  3. Confirm the DB stored the new details and dropped the old ones.
  4. Open the "Preview PDF" modal. Read the preview iframe's blob URL, fetch its
     bytes in the page, and assert the PREVIEW PDF shows "DNACPR: <new>" and
     "TEP: <new>" and neither old value.
  5. Click "Download PDF" and assert the DOWNLOADED PDF shows the same new
     values and neither old value.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/escalation-dnacpr-edit-preview-and-pdf-latest.e2e.py
Exits 0 on success, non-zero on failure.
"""

import base64
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

MARKER = f"E2EESCPREV{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.S.C."

SUFFIX = str(int(time.time()))[-6:]
HOSPITAL_NUMBER = f"HN{SUFFIX}"
DNACPR_OLD = f"DNRold{SUFFIX}"
DNACPR_NEW = f"DNRnew{SUFFIX}"
TEP_OLD = f"TEPold{SUFFIX}"
TEP_NEW = f"TEPnew{SUFFIX}"


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
            "age": 72,
            "hospital_number": HOSPITAL_NUMBER,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            # Complete critical fields so the export guard allows generation.
            "current_admission": f"Admission {MARKER}",
            # weight_kg is a required field in the edit form's validation.
            "weight_kg": 80,
            # Pre-existing TEP + DNACPR entry that the UI edit will replace.
            "tep_in_place": True,
            "tep_details": TEP_OLD,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_OLD,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_flags(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details,dnacpr_decision,dnacpr_details",
        headers=admin_headers(),
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


def cleanup(patient_id, user_id):
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
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return out.stdout, packed(out.stdout)


def read_preview_pdf(page, out_path):
    """Fetch the preview iframe's blob PDF into a local file for text checks."""
    iframe = page.locator('iframe[title="Handover PDF preview"]')
    expect(iframe).to_be_visible(timeout=15000)
    # The blob URL is stable once generated; wait until the src is a blob.
    page.wait_for_function(
        """() => {
             const el = document.querySelector('iframe[title="Handover PDF preview"]');
             return !!el && (el.getAttribute('src') || '').startsWith('blob:');
           }""",
        timeout=15000,
    )
    src = iframe.get_attribute("src")
    blob_url = src.split("#")[0]
    b64 = page.evaluate(
        """async (u) => {
             const r = await fetch(u);
             const buf = await r.arrayBuffer();
             const bytes = new Uint8Array(buf);
             let bin = '';
             for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
             return btoa(bin);
           }""",
        blob_url,
    )
    out_path.write_bytes(base64.b64decode(b64))
    assert out_path.read_bytes()[:5] == b"%PDF-", "preview blob is not a PDF"


def assert_latest_only(packed_text, where):
    assert f"DNACPR:{DNACPR_NEW}" in packed_text, (
        f"{where} missing updated DNACPR value 'DNACPR: {DNACPR_NEW}'"
    )
    assert f"TEP:{TEP_NEW}" in packed_text, (
        f"{where} missing updated TEP value 'TEP: {TEP_NEW}'"
    )
    assert DNACPR_OLD not in packed_text, (
        f"stale DNACPR details '{DNACPR_OLD}' leaked into {where}"
    )
    assert TEP_OLD not in packed_text, (
        f"stale TEP details '{TEP_OLD}' leaked into {where}"
    )


def main():
    user_id = patient_id = None
    preview_pdf = SCREENSHOTS / f"escalation_preview_{MARKER}.pdf"
    download_pdf = SCREENSHOTS / f"escalation_download_{MARKER}.pdf"
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

            # ---- Edit escalation plan + DNACPR via the UI ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )
            expect(
                page.get_by_text(PATIENT_NAME, exact=False).first
            ).to_be_visible(timeout=15000)

            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible(timeout=10000)

            tep_details = dialog.locator(
                "div.space-y-1\\.5:has(> label:text-is('TEP details')) textarea"
            )
            expect(tep_details).to_have_value(TEP_OLD, timeout=10000)
            tep_details.fill(TEP_NEW)

            dnacpr_details = dialog.locator(
                "div.space-y-1\\.5:has(> label:text-is('DNACPR details')) input"
            )
            expect(dnacpr_details).to_have_value(DNACPR_OLD, timeout=10000)
            dnacpr_details.fill(DNACPR_NEW)

            dialog.get_by_role("button", name="Save changes").click()
            expect(dialog).to_be_hidden(timeout=15000)

            # ---- Verify only new details persisted server-side ----
            saved = read_flags(patient_id)
            assert saved["tep_in_place"] is True, f"TEP toggle lost: {saved}"
            assert saved["dnacpr_decision"] is True, f"DNACPR toggle lost: {saved}"
            assert saved["tep_details"] == TEP_NEW, f"TEP details not updated: {saved}"
            assert saved["dnacpr_details"] == DNACPR_NEW, (
                f"DNACPR details not updated: {saved}"
            )

            # ---- Open the Preview PDF modal ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(
                page.get_by_text(PATIENT_NAME, exact=False).first
            ).to_be_visible(timeout=15000)

            # Narrow the board to just this patient so the export guard only
            # validates our (complete) record, not other rows in the shared DB.
            search = page.get_by_placeholder("Search initials or hospital no.…")
            search.fill(HOSPITAL_NUMBER)
            page.wait_for_timeout(600)

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=15000)
            preview_btn.click()

            export_dialog = page.get_by_role("dialog")
            expect(export_dialog).to_be_visible(timeout=10000)

            # ---- Assert the PREVIEW reflects the latest saved values ----
            read_preview_pdf(page, preview_pdf)
            _, preview_packed = extract_pdf_text(preview_pdf)
            assert_latest_only(preview_packed, "PDF preview")

            # ---- Download and assert the DOWNLOAD matches ----
            download_btn = export_dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_enabled(timeout=15000)
            with page.expect_download(timeout=30000) as dl_info:
                download_btn.click()
            dl_info.value.save_as(str(download_pdf))

            browser.close()

        _, download_packed = extract_pdf_text(download_pdf)
        assert_latest_only(download_packed, "downloaded PDF")

        for p in (preview_pdf, download_pdf):
            try:
                p.unlink()
            except OSError:
                pass

        print(
            "PASS: editing escalation plan + DNACPR updates both the PDF preview "
            "and the downloaded PDF to the latest values; pre-edit values do not leak"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
