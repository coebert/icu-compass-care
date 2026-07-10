"""
End-to-end test: investigations lifecycle — recording, "most recent"
summaries, and persistence through discharge and partner (bridge) sync.

Drives the real ICU handover app in a headless browser as an authenticated
admin/clinician and exercises the Investigations tab of a patient record:

  1. RECORD (lab + imaging) — add multiple investigation results across
     categories:
       * an OLDER "Bloods" result (lab), dated to the previous month
       * a NEWER "Bloods" result (lab), dated now
       * a "CXR" result (imaging), dated now
  2. MOST-RECENT SUMMARY UPDATES — the "Most recent results" section shows one
     card per category holding the latest entry by result date:
       * after only the OLD Bloods exists, the Bloods summary shows it
       * after the NEW Bloods is added, the Bloods summary switches to it
         (the summary count flips: NEW appears in both summary + history,
         OLD only in history)
       * the CXR summary shows the imaging result independently
  3. PERSIST AFTER DISCHARGE — discharging the patient (status -> Discharged)
     leaves every investigation and summary intact on the record.
  4. PERSIST AFTER PARTNER SYNC — the cross-project bridge endpoint
     (GET /api/public/bridge/investigations, HMAC-signed as a clinician)
     returns the same three results for the patient, newest first, proving the
     partner app sees identical persisted data.

The patient row and throwaway admin user are created and removed via the
Supabase admin REST API. Investigations cascade-delete with the patient.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
  HANDOVER_API_SECRET

Run:  python3 tests/e2e/investigations-lifecycle.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import hmac
import json
import os
import re
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
BRIDGE_SECRET = os.environ["HANDOVER_API_SECRET"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"INV{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

BLOODS_OLD = f"{MARKER}-BLOODS-OLD"
BLOODS_NEW = f"{MARKER}-BLOODS-NEW"
CXR_IMG = f"{MARKER}-CXR-IMG"


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


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": "E2E INV",
            "age": 58,
            "location_type": "icu",
            "status": "admitted",
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


def cleanup(user_id, patient_id):
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


def bridge_get_investigations(patient_id):
    """Fetch investigations as the partner app would: HMAC-signed GET."""
    actor = json.dumps(
        {"id": "00000000-0000-0000-0000-000000000000", "email": "partner@care.test", "role": "clinician"}
    )
    ts = str(int(time.time()))
    sig = hmac.new(
        BRIDGE_SECRET.encode(), f"{ts}.{actor}.".encode(), hashlib.sha256
    ).hexdigest()
    r = requests.get(
        f"{BASE_URL}/api/public/bridge/investigations",
        params={"patient_id": patient_id},
        headers={"x-timestamp": ts, "x-actor": actor, "x-signature": sig},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["investigations"]


# ---- UI helpers -------------------------------------------------------------

def add_investigation(page, *, category, findings, older=False):
    page.get_by_role("button", name="Add result").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=15000)

    if category != "Bloods":  # "Bloods" is the default selected category
        dialog.get_by_text("Category", exact=True).locator(
            "xpath=following-sibling::button"
        ).click()
        page.get_by_role("option", name=category, exact=True).click()

    dialog.get_by_text("Findings", exact=True).locator(
        "xpath=following-sibling::textarea"
    ).fill(findings)

    if older:
        field = dialog.get_by_text("Date / time of result", exact=True)
        field.locator("xpath=following-sibling::div//button").click()
        popover = page.locator("[data-radix-popper-content-wrapper]")
        expect(popover).to_be_visible(timeout=10000)
        popover.get_by_role("button", name=re.compile("previous", re.I)).click()
        popover.get_by_text("15", exact=True).first.click()

    dialog.get_by_role("button", name="Save").click()
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)


def open_investigations(page):
    page.get_by_role("tab", name="Investigations").click()
    expect(page.get_by_text("Most recent results", exact=True)).to_be_visible(timeout=15000)


def main():
    user_id = None
    patient_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"
            open_investigations(page)

            # ---- 1a. RECORD older lab result; it is the current 'most recent' ----
            # Date it to the previous month (picker opens on the current month).
            add_investigation(page, category="Bloods", findings=BLOODS_OLD, nav="prev")
            # summary (Most recent Bloods) + history => 2 occurrences.
            expect(page.get_by_text(BLOODS_OLD, exact=True)).to_have_count(2, timeout=15000)

            # ---- 1b/2. RECORD newer lab result; summary must switch to it ----
            # The picker reopens on the previous month (retained value); step
            # forward one month so this result is genuinely later than OLD.
            add_investigation(page, category="Bloods", findings=BLOODS_NEW, nav="next")
            # NEW now owns the Bloods summary (summary + history = 2),
            # OLD drops to history only (1) -> proves the summary updated.
            expect(page.get_by_text(BLOODS_NEW, exact=True)).to_have_count(2, timeout=15000)
            expect(page.get_by_text(BLOODS_OLD, exact=True)).to_have_count(1, timeout=15000)


            # ---- 1c. RECORD imaging result; independent summary card ----
            add_investigation(page, category="CXR", findings=CXR_IMG)
            expect(page.get_by_text(CXR_IMG, exact=True)).to_have_count(2, timeout=15000)
            expect(page.get_by_text("Most recent CXR", exact=True)).to_be_visible(timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "inv_1_recorded.png"))

            # ---- 3. PERSIST AFTER DISCHARGE ----
            page.get_by_role("button", name="Edit").click()
            edit = page.get_by_role("dialog")
            expect(edit).to_be_visible(timeout=15000)
            edit.get_by_text("Status", exact=True).locator(
                "xpath=following-sibling::button"
            ).click()
            page.get_by_role("option", name="Discharged").click()
            edit.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)
            expect(page.get_by_text("Discharged", exact=False).first).to_be_visible(timeout=15000)

            open_investigations(page)
            # Every result + summary is unchanged on the discharged record.
            expect(page.get_by_text(BLOODS_NEW, exact=True)).to_have_count(2, timeout=15000)
            expect(page.get_by_text(BLOODS_OLD, exact=True)).to_have_count(1, timeout=15000)
            expect(page.get_by_text(CXR_IMG, exact=True)).to_have_count(2, timeout=15000)
            page.screenshot(path=str(SCREENSHOTS / "inv_2_after_discharge.png"))

            browser.close()

        # ---- 4. PERSIST AFTER PARTNER SYNC (bridge pull) ----
        rows = bridge_get_investigations(patient_id)
        findings = [r["findings"] for r in rows]
        assert set([BLOODS_OLD, BLOODS_NEW, CXR_IMG]).issubset(set(findings)), (
            f"partner sync missing results: {findings}"
        )
        assert len([f for f in findings if f in (BLOODS_OLD, BLOODS_NEW, CXR_IMG)]) == 3, (
            f"expected exactly 3 results for patient, got {findings}"
        )
        # Bridge returns newest-first: the newer Bloods precedes the older one.
        assert findings.index(BLOODS_NEW) < findings.index(BLOODS_OLD), (
            f"partner sync order not newest-first: {findings}"
        )

        print(
            "PASS: investigations recorded (lab + imaging), most-recent summaries "
            "updated, and results persisted through discharge and partner sync"
        )
        return 0
    finally:
        cleanup(user_id, patient_id)


if __name__ == "__main__":
    sys.exit(main())
