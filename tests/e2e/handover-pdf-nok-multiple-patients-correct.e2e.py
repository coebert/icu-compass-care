"""
End-to-end test: next-of-kin details AND the "Last updated / spoken to"
timestamp are rendered against the CORRECT patient in a multi-patient handover
PDF — never swapped or leaked between records.

The existing single-patient test (handover-pdf-nok-spoken-to.e2e.py) proves the
NOK line renders. This test raises the bar: it seeds TWO patients, each with its
own distinct NOK name / relationship / contact / updating staff and its own
distinct "spoken to" instant, then exports the multi-patient handover PDF and
asserts:

  1. Each patient's full NOK line renders verbatim, in the exact format
     flags() produces in src/lib/handover-pdf.ts:
        NOK: <name> (<relationship>) <contact> [Spoken to <dd/mm/yyyy, HH:MM> by <staff>]
     with the timestamp formatted by fmtDateTime() (en-GB, 24h).
  2. Each NOK line sits inside ITS OWN patient's section of the PDF (region
     between that patient's name and the next patient's name), proving correct
     attribution.
  3. No "swapped" line exists — patient A's NOK details never appear in
     patient B's section and vice versa.

NOK data is seeded directly via the Supabase admin REST API (the UI path is
already covered elsewhere), so this test focuses purely on the PDF's
per-patient rendering contract. Throwaway admin user + patients are cleaned up
afterwards; nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-nok-multiple-patients-correct.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone as _utc
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

MARKER = f"NOKMULTI{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

# Pin the render timezone so fmtDateTime() output is deterministic.
TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)


def stamp_for(day, hour, minute):
    """A fixed UTC instant this month, plus its en-GB local render."""
    now = datetime.now(TZ)
    inst = datetime(now.year, now.month, day, hour, minute, tzinfo=_utc.utc)
    return inst.isoformat(), inst.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


UPD_A_ISO, UPD_A_STAMP = stamp_for(11, 9, 15)
UPD_B_ISO, UPD_B_STAMP = stamp_for(19, 16, 40)

# Two patients, each with fully distinct, uniquely greppable NOK details.
PATIENTS = [
    {
        "full_name": f"{MARKER}-ALPHA",
        "nok_name": f"{MARKER}-KINALPHA",
        "nok_relationship": f"{MARKER}-WIFE",
        "nok_contact": f"{MARKER}-07700900111",
        "nok_last_updated": UPD_A_ISO,
        "nok_last_updated_by": f"{MARKER}-NURSEA",
        "stamp": UPD_A_STAMP,
    },
    {
        "full_name": f"{MARKER}-BRAVO",
        "nok_name": f"{MARKER}-KINBRAVO",
        "nok_relationship": f"{MARKER}-SON",
        "nok_contact": f"{MARKER}-07700900222",
        "nok_last_updated": UPD_B_ISO,
        "nok_last_updated_by": f"{MARKER}-NURSEB",
        "stamp": UPD_B_STAMP,
    },
]


def packed(s):
    return "".join(s.split())


def nok_line(p):
    return (
        f"NOK: {p['nok_name']} ({p['nok_relationship']}) {p['nok_contact']} "
        f"[Spoken to {p['stamp']} by {p['nok_last_updated_by']}]"
    )


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


def create_patients():
    ids = []
    for p in PATIENTS:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/patients",
            headers={**admin_headers(), "Prefer": "return=representation"},
            json={
                "full_name": p["full_name"],
                "age": 70,
                "location_type": "icu",
                "ward": "Critical Care",
                "status": "admitted",
                "nok_name": p["nok_name"],
                "nok_relationship": p["nok_relationship"],
                "nok_contact": p["nok_contact"],
                "nok_last_updated": p["nok_last_updated"],
                "nok_last_updated_by": p["nok_last_updated_by"],
            },
            timeout=30,
        )
        r.raise_for_status()
        ids.append(r.json()[0]["id"])
    return ids


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(user_id, patient_ids):
    for pid in patient_ids or []:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
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
    return out.stdout


def main():
    user_id = None
    patient_ids = []
    try:
        user_id, email = create_admin_user()
        patient_ids = create_patients()
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
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"
            for p in PATIENTS:
                expect(page.get_by_text(p["full_name"], exact=False).first).to_be_visible(
                    timeout=15000
                )

            # ---- Export + download the multi-patient handover PDF ----
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

        raw_text = extract_pdf_text(pdf_path)
        packed_text = packed(raw_text)

        # ---- Each patient's full NOK line renders verbatim ----
        for p in PATIENTS:
            line = packed(nok_line(p))
            assert line in packed_text, (
                f"NOK line for {p['full_name']} missing/misformatted in PDF.\n"
                f"expected: {line}"
            )
            # spoken-to stamp must be a real dd/mm/yyyy, HH:MM value
            assert re.fullmatch(r"\d{2}/\d{2}/\d{4},\d{2}:\d{2}", packed(p["stamp"])), (
                f"bad expected stamp {p['stamp']!r} (test bug)"
            )

        # ---- Correct attribution: each NOK line lives in its own patient's
        #      section (region between this patient name and the next one) ----
        # Locate each patient name in the packed text and sort by position.
        located = []
        for p in PATIENTS:
            idx = packed_text.find(packed(p["full_name"]))
            assert idx != -1, f"patient name {p['full_name']} not found in PDF"
            located.append((idx, p))
        located.sort(key=lambda t: t[0])

        for i, (start, p) in enumerate(located):
            end = located[i + 1][0] if i + 1 < len(located) else len(packed_text)
            region = packed_text[start:end]
            own = packed(nok_line(p))
            assert own in region, (
                f"{p['full_name']}'s NOK line not within its own PDF section — "
                f"attribution/order problem"
            )
            # No other patient's NOK identity may appear in this section.
            for other in PATIENTS:
                if other is p:
                    continue
                for stray in (
                    other["nok_name"],
                    other["nok_contact"],
                    other["nok_last_updated_by"],
                ):
                    assert packed(stray) not in region, (
                        f"cross-bleed: {other['full_name']}'s NOK value '{stray}' "
                        f"leaked into {p['full_name']}'s section"
                    )

        # ---- Defensive: no swapped line (patientA name + patientB NOK) ----
        a, b = PATIENTS
        swapped_a = packed(
            f"NOK: {b['nok_name']} ({a['nok_relationship']}) {a['nok_contact']}"
        )
        assert swapped_a not in packed_text, "detected a swapped NOK line in PDF"

        print("PASS: both patients' NOK details + spoken-to timestamps render "
              "correctly and are attributed to the right patient.")
        return 0
    finally:
        cleanup(user_id, patient_ids)


if __name__ == "__main__":
    sys.exit(main())
