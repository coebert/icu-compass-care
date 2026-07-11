"""
End-to-end test: for a discharged patient, the handover PDF *preview* (the
in-app embedded viewer) AND the *downloaded* PDF both show a discharge
destination and status that match the latest saved record values.

Why both surfaces: the preview iframe and the Download button are built from the
same client-side generator, but a regression could desync one from the saved
record. This test proves both reflect the database after a real UI edit.

Flow (driven through the app UI with an authenticated clinician session):
  1. Seed a discharged patient (with a unique hospital number so the board
     search narrows the preview/download to just this one patient).
  2. Sign in, open the record, and via the Edit dialog change the discharge
     destination to a NEW value; save. This becomes the "latest saved" value.
  3. Read the database back — capture the authoritative status + destination.
  4. On /patients, search the unique hospital number so the PDF surfaces render
     ONLY this patient.
  5. Open "Preview PDF"; fetch the preview iframe's PDF bytes and assert the
     rendered text contains the DB status ("Discharged") and destination
     ("To <dest>"), and not the stale original destination.
  6. Click "Download PDF"; save the file and assert the downloaded PDF contains
     the same DB status + destination.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/discharge-pdf-preview-and-download-match-record.e2e.py
Exits 0 on success, non-zero on failure.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
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

MARKER = f"E2EPPD{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "P.P.PDF"
HOSP_NO = f"H-{MARKER}"
TODAY = datetime.now(timezone.utc).date().isoformat()

OLD_DEST = f"Old ward X {MARKER}"
NEW_DEST = f"Community rehab unit {MARKER}"


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
            "age": 74,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "3",
            "hospital_number": HOSP_NO,
            "current_admission": "Post-op recovery, now fit for step-down.",
            "status": "discharged",
            "admission_date": TODAY,
            "discharge_date": TODAY,
            "discharge_destination": OLD_DEST,
            "weight_kg": 79,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_destination",
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


def pdf_text_from_bytes(data, tag):
    path = SCREENSHOTS / f"handover_{MARKER}_{tag}.pdf"
    path.write_bytes(data)
    out = subprocess.run(
        ["pdftotext", "-raw", str(path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed ({tag}): {out.stderr}")
    try:
        path.unlink()
    except OSError:
        pass
    return out.stdout, packed(out.stdout)


FETCH_IFRAME_PDF = """
async () => {
  const el = document.querySelector('iframe[title="Handover PDF preview"]');
  if (!el || !el.src) return null;
  const src = el.src.split('#')[0];
  const resp = await fetch(src);
  const buf = await resp.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
"""


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

            # ---- 1. Edit the discharge destination via the Edit dialog ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            page.get_by_role("button", name="Edit").click()
            dlg = page.get_by_role("dialog")
            expect(dlg.get_by_text("Edit patient")).to_be_visible(timeout=10000)
            dest = dlg.locator('div:has(> label:text-is("Discharge destination")) input')
            expect(dest).to_have_value(OLD_DEST, timeout=10000)
            dest.fill(NEW_DEST)
            dlg.get_by_role("button", name="Save changes").click()
            expect(page.get_by_text("Patient updated")).to_be_visible(timeout=15000)

            # ---- 2. Authoritative latest saved values from the database ----
            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status changed: {row['status']!r}"
            assert row["discharge_destination"] == NEW_DEST, (
                f"latest destination not saved: {row['discharge_destination']!r}"
            )

            # ---- 3. Narrow the board to just this patient via search ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            page.get_by_placeholder("Search initials or hospital no.…").fill(HOSP_NO)
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- 4. Open the PDF preview and read the rendered bytes ----
            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_enabled(timeout=10000)
            preview_btn.click()

            iframe = page.locator('iframe[title="Handover PDF preview"]')
            expect(iframe).to_be_visible(timeout=15000)

            b64 = None
            for _ in range(20):
                b64 = page.evaluate(FETCH_IFRAME_PDF)
                if b64:
                    break
                page.wait_for_timeout(500)
            assert b64, "could not read PDF bytes from the preview iframe"
            page.screenshot(path=str(SCREENSHOTS / "ppd_preview.png"))

            preview_raw, preview_packed = pdf_text_from_bytes(base64.b64decode(b64), "preview")
            assert packed(PATIENT_NAME) in preview_packed, "patient missing from preview PDF"
            assert "Discharged" in preview_packed, "'Discharged' status missing from preview PDF"
            assert packed(f"To {NEW_DEST}") in preview_packed, (
                "latest discharge destination missing from preview PDF"
            )
            assert packed(OLD_DEST) not in preview_packed, "stale destination still in preview PDF"

            # ---- 5. Download the PDF and check the same values ----
            download_btn = page.get_by_role("dialog").get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_enabled(timeout=10000)
            with page.expect_download(timeout=30000) as dl_info:
                download_btn.click()
            dl = dl_info.value
            dl_path = SCREENSHOTS / f"handover_{MARKER}_download.pdf"
            dl.save_as(str(dl_path))
            assert dl.suggested_filename.lower().endswith(".pdf")

            browser.close()

        dl_bytes = dl_path.read_bytes()
        try:
            dl_path.unlink()
        except OSError:
            pass
        download_raw, download_packed = pdf_text_from_bytes(dl_bytes, "download")

        assert packed(PATIENT_NAME) in download_packed, "patient missing from downloaded PDF"
        assert "Discharged" in download_packed, "'Discharged' status missing from downloaded PDF"
        assert packed(f"To {NEW_DEST}") in download_packed, (
            "latest discharge destination missing from downloaded PDF"
        )
        assert packed(OLD_DEST) not in download_packed, "stale destination still in downloaded PDF"

        print(
            "PASS: both the PDF preview and the downloaded PDF show the latest "
            f"saved status (Discharged) and destination (To {NEW_DEST})"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
