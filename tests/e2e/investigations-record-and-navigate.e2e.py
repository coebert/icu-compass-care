"""
End-to-end test: recording investigation results through the app and confirming
the "most recent" widgets for Bloods, CXR and CT chest render and can be
navigated to.

This complements recent-investigations-ordering.e2e.py (which seeds rows via
the admin REST API and only checks the Overview cards). Here we RECORD each
result through the app's genuine TanStack server-function RPC client
(addInvestigation in src/lib/investigations.functions.ts) — the same path the
Add-result dialog uses — and then verify the two "most recent" surfaces both
render the newest value per category and that tab navigation reaches them:

  1. Record two results per category (Bloods / CXR / CT chest) through the app,
     older BEFORE newer, so the newest must win by result_at, not save order.
  2. Overview tab: the "Most recent investigations" card shows each category's
     newest finding (and not the superseded older one).
  3. Navigate to the Investigations tab: it becomes active, and the
     "Most recent {category}" cards render the newest finding per category.
  4. Navigate back to Overview: the tab switch works both ways.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigations-record-and-navigate.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
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

MARKER = f"E2ERECNAV{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "N.A.V."

SUFFIX = str(int(time.time()))[-6:]
# Per category: (old finding, new finding). Recorded old first, then new.
CASES = {
    "Bloods": (f"BLDOLD{SUFFIX}", f"BLDNEW{SUFFIX}"),
    "CXR": (f"CXROLD{SUFFIX}", f"CXRNEW{SUFFIX}"),
    "CT chest": (f"CTOLD{SUFFIX}", f"CTNEW{SUFFIX}"),
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
            "age": 63,
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


def call_fn(page, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": INV_MODULE, "name": name, "data": data}
    )


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        now = datetime.now(timezone.utc)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 1. Record each result through the app (old first, then new) ----
            for category, (old_find, new_find) in CASES.items():
                old_r = call_fn(
                    page,
                    "addInvestigation",
                    {
                        "patientId": patient_id,
                        "category": category,
                        "findings": old_find,
                        "result_at": (now - timedelta(days=3)).isoformat(),
                    },
                )
                assert old_r["ok"], f"recording old {category} failed: {old_r.get('error')}"
                new_r = call_fn(
                    page,
                    "addInvestigation",
                    {
                        "patientId": patient_id,
                        "category": category,
                        "findings": new_find,
                        "result_at": now.isoformat(),
                    },
                )
                assert new_r["ok"], f"recording new {category} failed: {new_r.get('error')}"

            # ---- 2. Overview tab: "Most recent investigations" card ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            overview = page.get_by_role("tabpanel")
            expect(
                page.get_by_role("heading", name="Most recent investigations")
            ).to_be_visible(timeout=15000)
            for category, (old_find, new_find) in CASES.items():
                expect(overview.get_by_text(new_find, exact=False)).to_be_visible(
                    timeout=10000
                )
                assert overview.get_by_text(old_find, exact=False).count() == 0, (
                    f"Overview card wrongly shows superseded {category} result {old_find}"
                )
            page.screenshot(path=str(SCREENSHOTS / "recnav_overview.png"))

            # ---- 3. Navigate to the Investigations tab ----
            inv_tab = page.get_by_role("tab", name="Investigations")
            inv_tab.scroll_into_view_if_needed()
            inv_tab.click()
            expect(inv_tab).to_have_attribute("data-state", "active", timeout=10000)
            expect(
                page.get_by_role("heading", name="Most recent results")
            ).to_be_visible(timeout=15000)

            inv_panel = page.get_by_role("tabpanel")
            for category, (old_find, new_find) in CASES.items():
                # The "Most recent {category}" card exists...
                expect(
                    inv_panel.get_by_text(f"Most recent {category}", exact=True).first
                ).to_be_visible(timeout=10000)
                # ...and shows the newest finding.
                expect(inv_panel.get_by_text(new_find, exact=False).first).to_be_visible(
                    timeout=10000
                )
            page.screenshot(path=str(SCREENSHOTS / "recnav_investigations.png"))

            # ---- 4. Navigate back to Overview ----
            overview_tab = page.get_by_role("tab", name="Overview")
            overview_tab.scroll_into_view_if_needed()
            overview_tab.click()
            expect(overview_tab).to_have_attribute("data-state", "active", timeout=10000)
            expect(
                page.get_by_role("heading", name="Most recent investigations")
            ).to_be_visible(timeout=10000)

            browser.close()

        print("PASS: recorded results; most-recent Bloods/CXR/CT chest widgets render and navigate")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
