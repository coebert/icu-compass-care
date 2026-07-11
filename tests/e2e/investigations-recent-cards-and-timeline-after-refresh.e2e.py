"""
End-to-end test (UI-driven): saving new investigation findings through the real
Add-result dialog makes the "Most recent Bloods" and "Most recent CXR" cards show
the saved findings, that stays correct after a HARD REFRESH, and the Timeline tab
auto-surfaces both investigations (title = category, detail = findings).

Surfaces exercised (src/routes/_authenticated/patients.$patientId.tsx):
  - Investigations tab -> "Most recent results" -> "Most recent Bloods" / "Most
    recent CXR" cards (newest per category).
  - Timeline tab -> investigations are pushed as timeline events with
    title = category and detail = findings (see TimelineTab, evs.push for
    investigations).

Flow:
  1. Seed a clinician user + an admitted patient (admin REST API); sign in.
  2. On the Investigations tab, add a Bloods result and a CXR result via the real
     "Add investigation result" dialog (category Select + Findings + date/time).
  3. Before refresh: the "Most recent Bloods"/"Most recent CXR" cards show the
     saved findings.
  4. HARD REFRESH.
  5. After refresh: the most-recent cards still show the saved findings, and the
     Timeline tab lists both investigations with their category + findings.

Throwaway user + patient (and its investigations) are removed via the Supabase
admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigations-recent-cards-and-timeline-after-refresh.e2e.py
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
MARKER = f"E2E-INVREC-{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "I.N.V."

BLOODS_FINDINGS = f"Hb 96 K 4.1 CRP 88 {STAMP}"
CXR_FINDINGS = f"Right basal consolidation, no pneumothorax {STAMP}"


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
            "age": 64,
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


def db_investigations(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}&select=category,findings",
        headers=admin_headers(),
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


def add_result(page, panel, category, findings):
    """Add one investigation via the real 'Add investigation result' dialog."""
    panel.get_by_role("button", name="Add result").click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_text("Add investigation result")).to_be_visible(timeout=10000)
    # Category is a radix Select (combobox); default is Bloods.
    if category != "Bloods":
        dialog.get_by_role("combobox").click()
        page.get_by_role("option", name=category, exact=True).click()
    dialog.get_by_role("textbox").last.fill(findings)
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_text("Investigation saved").first).to_be_visible(timeout=10000)
    expect(page.get_by_role("dialog")).to_have_count(0, timeout=10000)


def recent_card(page, category):
    """The 'Most recent {category}' card (nearest card ancestor)."""
    return page.get_by_text(f"Most recent {category}", exact=True).locator(
        "xpath=ancestor::div[contains(@class,'rounded-xl')][1]"
    )


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

            # ---- 1. Add a Bloods result and a CXR result ----
            panel = open_tab(page, "Investigations")
            add_result(page, panel, "Bloods", BLOODS_FINDINGS)
            add_result(page, panel, "CXR", CXR_FINDINGS)

            # ---- 2. Before refresh: most-recent cards show the saved findings ----
            expect(recent_card(page, "Bloods")).to_contain_text(BLOODS_FINDINGS, timeout=10000)
            expect(recent_card(page, "CXR")).to_contain_text(CXR_FINDINGS, timeout=10000)
            page.screenshot(path=str(SCREENSHOTS / "invrec_before_refresh.png"))

            # ---- DB persistence sanity check ----
            rows = db_investigations(patient_id)
            by_cat = {r["category"]: r["findings"] for r in rows}
            assert by_cat.get("Bloods") == BLOODS_FINDINGS, f"Bloods not stored: {rows!r}"
            assert by_cat.get("CXR") == CXR_FINDINGS, f"CXR not stored: {rows!r}"

            # ---- 3. HARD REFRESH ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 4. After refresh: most-recent cards still correct ----
            panel = open_tab(page, "Investigations")
            expect(recent_card(page, "Bloods")).to_contain_text(BLOODS_FINDINGS, timeout=10000)
            expect(recent_card(page, "CXR")).to_contain_text(CXR_FINDINGS, timeout=10000)

            # ---- 5. After refresh: Timeline reflects both investigations ----
            timeline = open_tab(page, "Timeline")
            tl_text = timeline.inner_text()
            assert BLOODS_FINDINGS in tl_text, f"Timeline missing Bloods findings:\n{tl_text!r}"
            assert CXR_FINDINGS in tl_text, f"Timeline missing CXR findings:\n{tl_text!r}"
            # Category titles are shown on the timeline entries too.
            assert "Bloods" in tl_text and "CXR" in tl_text, (
                f"Timeline missing category titles:\n{tl_text!r}"
            )
            page.screenshot(path=str(SCREENSHOTS / "invrec_timeline_after_refresh.png"))

            browser.close()

        print(
            "PASS: saved Bloods + CXR findings; 'Most recent Bloods'/'Most recent CXR' "
            "cards update and persist after refresh, and the Timeline reflects both"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
