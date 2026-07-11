"""
End-to-end test: after EDITING a patient's investigations through the real UI,
downloading the handover PDF shows the UPDATED most-recent Bloods, CXR, and
CT chest results — and neither the superseded older result nor the pre-edit
placeholder text for those three sections.

Flow (full UI round-trip), for each of Bloods / CXR / CT chest:
  1. Seed TWO investigations via the admin API:
       - an OLDER result (2 days ago) with an OLD finding  -> must be superseded
       - a NEWER result (yesterday 09:00) with a PLACEHOLDER finding
  2. In the Investigations tab, open the NEWER record's Edit dialog, replace the
     findings with a NEW finding and change the time to 15:45 (same pinned date).
  3. Save and confirm the "Most recent <category>" card shows the new value.
  4. Export the handover PDF and assert, per section:
       - 'Bloods: <new>  (<new stamp>)'   present
       - 'CXR: <new>     (<new stamp>)'   present
       - 'CT chest: <new> (<new stamp>)'  present
       - OLD finding and PLACEHOLDER finding both ABSENT (only newest shows).

The handover PDF's investigations column renders exactly these three key
categories (see RECENT_INVESTIGATION_CATEGORIES = Bloods, CXR, CT chest), one
line each with the newest finding and its result time. Browser timezone is
pinned (Europe/London) so the picker and fmtDateTime() agree deterministically.

Throwaway clinician user + patient (+investigations) are created and cleaned up
via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-edited-bloods-cxr-ctchest-latest.e2e.py
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

MARKER = f"E2EPDFINV{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "I.V.X."

TZ_ID = "Europe/London"
TZ = ZoneInfo(TZ_ID)
SUFFIX = str(int(time.time()))[-6:]

_today = datetime.now(TZ).date()
_older_day = _today - timedelta(days=2)
_newer_day = _today - timedelta(days=1)

OLDER_LOCAL = datetime(_older_day.year, _older_day.month, _older_day.day, 8, 0, tzinfo=TZ)
NEWER_SEED_LOCAL = datetime(_newer_day.year, _newer_day.month, _newer_day.day, 9, 0, tzinfo=TZ)
NEW_TIME = "15:45"
NEW_EDIT_LOCAL = datetime(_newer_day.year, _newer_day.month, _newer_day.day, 15, 45, tzinfo=TZ)

# One row of the plan per key category rendered in the PDF.
SECTIONS = [
    {
        "category": "Bloods",
        "old": f"BLDOLD{SUFFIX}",
        "placeholder": f"BLDTMP{SUFFIX}",
        "new": f"BLDNEW{SUFFIX}",
    },
    {
        "category": "CXR",
        "old": f"CXROLD{SUFFIX}",
        "placeholder": f"CXRTMP{SUFFIX}",
        "new": f"CXRNEW{SUFFIX}",
    },
    {
        "category": "CT chest",
        "old": f"CTCOLD{SUFFIX}",
        "placeholder": f"CTCTMP{SUFFIX}",
        "new": f"CTCNEW{SUFFIX}",
    },
]


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def fmt_datetime_engb(dt_local_aware):
    return dt_local_aware.astimezone(TZ).strftime("%d/%m/%Y, %H:%M")


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
            "age": 61,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Mgmt {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def add_investigation(patient_id, category, findings, result_at_iso):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": result_at_iso,
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


def edit_investigation(page, placeholder, new_finding):
    """Open the Edit dialog for the record carrying `placeholder`, replace its
    findings with `new_finding`, and change the time to NEW_TIME."""
    card = page.locator(
        "div.flex.items-start", has=page.get_by_text(placeholder, exact=True)
    )
    expect(card).to_be_visible(timeout=15000)
    card.get_by_role("button", name="Edit investigation").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=10000)
    dialog.locator("textarea").fill(new_finding)
    dialog.get_by_label("Time").fill(NEW_TIME)
    dialog.get_by_role("button", name="Save changes").click()
    expect(dialog).to_be_hidden(timeout=10000)
    expect(page.get_by_text(new_finding, exact=False).first).to_be_visible(timeout=10000)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        for s in SECTIONS:
            add_investigation(patient_id, s["category"], s["old"], iso(OLDER_LOCAL))
            add_investigation(patient_id, s["category"], s["placeholder"], iso(NEWER_SEED_LOCAL))

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

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            page.get_by_role("tab", name="Investigations").click()

            # Edit each section's newest record through the UI.
            for s in SECTIONS:
                edit_investigation(page, s["placeholder"], s["new"])

            # Export the handover PDF for THIS patient only (the per-patient
            # "Handover PDF" button on the detail page). This avoids the board's
            # whole-cohort export, which validation blocks if any other patient
            # in the dataset is incomplete.
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            export_btn = page.get_by_role("button", name="Handover PDF")
            expect(export_btn).to_be_enabled(timeout=15000)

            try:
                with page.expect_download(timeout=30000) as dl_info:
                    export_btn.click()
            except Exception:
                page.screenshot(path=str(SCREENSHOTS / f"handover_{MARKER}_nodl.png"))
                print("PAGE TEXT:", page.inner_text("body")[:2000], file=sys.stderr)
                raise
            download = dl_info.value
            pdf_path = SCREENSHOTS / f"handover_{MARKER}.pdf"
            download.save_as(str(pdf_path))
            assert download.suggested_filename.lower().endswith(".pdf")

            browser.close()

        raw_text, packed_text = extract_pdf_text(pdf_path)
        new_stamp = fmt_datetime_engb(NEW_EDIT_LOCAL)

        failures = []
        for s in SECTIONS:
            expected = packed(f"{s['category']}: {s['new']} ({new_stamp})")
            if expected not in packed_text:
                failures.append(
                    f"{s['category']}: expected '{s['category']}: {s['new']} ({new_stamp})' not in PDF"
                )
            if packed(s["old"]) in packed_text:
                failures.append(f"{s['category']}: superseded old finding '{s['old']}' still in PDF")
            if packed(s["placeholder"]) in packed_text:
                failures.append(f"{s['category']}: pre-edit placeholder '{s['placeholder']}' still in PDF")

        assert not failures, "Handover PDF investigation failures:\n  - " + "\n  - ".join(failures)

        try:
            pdf_path.unlink()
        except OSError:
            pass

        print(
            "PASS: handover PDF shows the UI-edited most-recent Bloods, CXR and "
            f"CT chest results (@ {new_stamp}); superseded and pre-edit values gone"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
