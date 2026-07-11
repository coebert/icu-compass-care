"""
End-to-end test (UI-driven): saving two different sets of blood results (an
earlier and a later one on the same day) makes the "most recent blood results"
panels show the LATER set, and that stays correct after a hard refresh.

Two panels surface the newest Bloods result and must agree:
  - Investigations tab -> "Most recent results" -> "Most recent Bloods" card.
  - Overview tab -> "Most recent investigations" -> Bloods cell.

Flow:
  1. Seed a clinician user + an admitted patient (admin REST API); sign in.
  2. On the Investigations tab, add TWO Bloods results via the real Add dialog:
     an EARLIER one (08:00, SET_A) then a LATER one (14:00, SET_B).
  3. Before refresh: the most-recent Bloods card shows SET_B, not SET_A.
  4. HARD REFRESH.
  5. After refresh: both the Investigations most-recent card AND the Overview
     summary show SET_B and never SET_A. The full history still lists both.

Throwaway user + patient (and its investigations) are removed via the Supabase
admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/bloods-most-recent-updates-after-refresh.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
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

STAMP = str(int(time.time()))
MARKER = f"E2E-BLOODS-{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "B.L.D."

# Two distinct blood-result sets, same day, different times.
SET_A = f"Hb 78 K 5.9 (08:00) {STAMP}"   # earlier
SET_B = f"Hb 104 K 4.2 (14:00) {STAMP}"  # later -> should win
TIME_A = "08:00"
TIME_B = "14:00"


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
            "age": 59,
            "location_type": "icu",
            "ward": "Critical Care",
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


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def add_bloods(page, panel, time_str, findings):
    """Add one Bloods result via the real Add-result dialog (category defaults to Bloods)."""
    panel.get_by_role("button", name="Add result").click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_text("Add investigation result")).to_be_visible(timeout=10000)
    dialog.get_by_label("Time").fill(time_str)
    dialog.get_by_role("textbox").last.fill(findings)
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_text("Investigation saved")).to_be_visible(timeout=10000)
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=10000)


def recent_bloods_card(page):
    """The 'Most recent Bloods' card on the Investigations tab."""
    return page.locator("div").filter(
        has=page.get_by_text("Most recent Bloods", exact=False)
    ).last


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 1. Add two Bloods results: earlier SET_A, then later SET_B ----
            panel = open_tab(page, "Investigations")
            add_bloods(page, panel, TIME_A, SET_A)
            add_bloods(page, panel, TIME_B, SET_B)

            # ---- 2. Before refresh: most-recent Bloods card shows SET_B only ----
            card = recent_bloods_card(page)
            expect(card).to_contain_text(SET_B, timeout=10000)
            assert SET_A not in card.inner_text(), (
                f"most-recent Bloods card shows the OLDER set before refresh:\n{card.inner_text()!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "bloods_recent_before_refresh.png"))

            # ---- 3. HARD REFRESH ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 4. After refresh: Investigations most-recent card = SET_B ----
            panel = open_tab(page, "Investigations")
            card = recent_bloods_card(page)
            expect(card).to_contain_text(SET_B, timeout=10000)
            assert SET_A not in card.inner_text(), (
                f"most-recent Bloods card shows the OLDER set after refresh:\n{card.inner_text()!r}"
            )
            # Full history retains BOTH results.
            history_text = panel.inner_text()
            assert SET_A in history_text and SET_B in history_text, (
                f"full history should list both results:\n{history_text!r}"
            )

            # ---- 5. After refresh: Overview summary Bloods cell = SET_B ----
            overview = open_tab(page, "Overview")
            summary = page.locator("div").filter(
                has=page.get_by_text("Most recent investigations")
            ).last
            expect(summary).to_contain_text(SET_B, timeout=10000)
            assert SET_A not in summary.inner_text(), (
                f"Overview summary shows the OLDER blood set:\n{summary.inner_text()!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "bloods_recent_after_refresh.png"))

            browser.close()

        print(
            "PASS: saving two blood-result sets updates the most-recent Bloods panels "
            "to the later set (Investigations + Overview), correct after refresh"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
