"""
End-to-end test (UI-driven): a clinician navigates through the Overview,
Escalation & Resus, Next of kin, and Investigations tabs of a patient record,
hard-refreshes the app, and every one of those tab sections must render fully —
with NO missing investigation summary values on the Overview "Most recent
investigations" card (no "No result recorded" / "—" placeholders where a
seeded result exists).

Flow:
  1. Seed a clinician user + a patient carrying escalation (TEP + DNACPR),
     next-of-kin and clinical-summary fields, plus one investigation result in
     each of the three summary categories (Bloods, CXR, CT chest).
  2. Sign in and open /patients/<id>.
  3. Walk Overview -> Escalation & Resus -> Next of kin -> Investigations,
     asserting each panel renders its seeded content.
  4. HARD REFRESH, then re-walk all four tabs and assert the same content still
     renders — and that the Overview investigation summary shows the seeded
     findings with no missing-value placeholders.

Throwaway user + patient (and its investigations) are removed via the Supabase
admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/tabs-render-after-refresh-no-missing-investigations.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
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

STAMP = str(int(time.time()))
MARKER = f"E2E-TABS-{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.A.B."

# Tab-specific content markers.
TEP_MARKER = f"TepDetails{STAMP}"
DNACPR_MARKER = f"DnacprDetails{STAMP}"
NOK_NAME = f"KinName{STAMP}"
NOK_REL = f"Daughter{STAMP}"
NOK_CONTACT = f"07700-{STAMP[-6:]}"

# One investigation per Overview summary category — findings must all show.
INV_FINDINGS = {
    "Bloods": f"Hb 96 CRP 210 {STAMP}",
    "CXR": f"RLL consolidation {STAMP}",
    "CT chest": f"Bilateral GGO {STAMP}",
}


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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Mgmt {STAMP}",
            "current_admission": f"Adm {STAMP}",
            "tep_in_place": True,
            "tep_details": TEP_MARKER,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_MARKER,
            "nok_name": NOK_NAME,
            "nok_relationship": NOK_REL,
            "nok_contact": NOK_CONTACT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def seed_investigations(patient_id):
    now = datetime.now(timezone.utc)
    rows = [
        {
            "patient_id": patient_id,
            "category": category,
            "findings": findings,
            "result_at": now.isoformat(),
        }
        for category, findings in INV_FINDINGS.items()
    ]
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
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


def check_overview(page, where):
    panel = open_tab(page, "Overview")
    # The "Most recent investigations" summary must show every seeded finding
    # and NO missing-value placeholder.
    card = panel.locator("div.rounded-lg, div").filter(
        has=page.get_by_text("Most recent investigations")
    ).first
    expect(page.get_by_text("Most recent investigations")).to_be_visible(timeout=10000)
    card_text = card.inner_text()
    for category, findings in INV_FINDINGS.items():
        assert findings in card_text, (
            f"[{where}] Overview summary missing {category} finding: {findings!r}\n{card_text!r}"
        )
    assert "No result recorded" not in card_text, (
        f"[{where}] Overview investigation summary has a missing value placeholder:\n{card_text!r}"
    )
    # Clinical summary blocks render.
    assert f"Mgmt {STAMP}" in panel.inner_text(), f"[{where}] current management missing"


def check_escalation(page, where):
    panel = open_tab(page, "Escalation & Resus")
    text = panel.inner_text()
    assert "TEP in place" in text, f"[{where}] TEP status not rendered"
    assert TEP_MARKER in text, f"[{where}] TEP details missing: {TEP_MARKER!r}"
    assert "DNACPR decision made" in text, f"[{where}] DNACPR status not rendered"
    assert DNACPR_MARKER in text, f"[{where}] DNACPR details missing: {DNACPR_MARKER!r}"


def check_nok(page, where):
    panel = open_tab(page, "Next of kin")
    text = panel.inner_text()
    for value in (NOK_NAME, NOK_REL, NOK_CONTACT):
        assert value in text, f"[{where}] NOK value missing: {value!r}\n{text!r}"


def check_investigations(page, where):
    panel = open_tab(page, "Investigations")
    text = panel.inner_text()
    assert "No investigations recorded." not in text, (
        f"[{where}] Investigations tab shows empty state despite seeded results"
    )
    for category, findings in INV_FINDINGS.items():
        assert findings in text, (
            f"[{where}] Investigations tab missing {category} finding: {findings!r}"
        )


def walk_all(page, where):
    check_overview(page, where)
    check_escalation(page, where)
    check_nok(page, where)
    check_investigations(page, where)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        seed_investigations(patient_id)
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

            # ---- 1. Walk all four tabs before refresh ----
            walk_all(page, "before refresh")
            page.screenshot(path=str(SCREENSHOTS / "tabs_before_refresh.png"))

            # ---- 2. HARD REFRESH ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )

            # ---- 3. Re-walk all four tabs after refresh ----
            walk_all(page, "after refresh")
            page.screenshot(path=str(SCREENSHOTS / "tabs_after_refresh.png"))

            browser.close()

        print(
            "PASS: Overview, Escalation, Next of kin and Investigations tabs render "
            "fully before and after refresh, with no missing investigation summary values"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
