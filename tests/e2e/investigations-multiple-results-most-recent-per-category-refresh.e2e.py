"""
End-to-end test: record MULTIPLE Bloods, CXR, and CT chest results for one
patient, refresh, and confirm the Investigations tab's "Most recent {category}"
card shows the finding with the newest result_at in each category.

Three results are recorded per category, saved deliberately out of date order
(oldest, then newest, then a back-dated one), so the test proves the tab tracks
the newest *result date* — not the most recently *saved* row:

  Bloods / CXR / CT chest, each with:
    #1  2 days ago    (older)
    #2  now           (NEWEST — must win)
    #3  5 days ago    (back-dated, saved last — must NOT win)

After a single hard refresh the Investigations tab is asserted:
  - the "Most recent {category}" card shows #2 for every category, and
  - that card never shows #1 or #3.

Results are recorded through the app's genuine TanStack server-function RPC
client (addInvestigation), the same path the Add-result dialog uses.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigations-multiple-results-most-recent-per-category-refresh.e2e.py
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

MARKER = f"E2EMULTI{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.M.R."

SUFFIX = str(int(time.time()))[-6:]
# Per category: (#1 older, #2 newest, #3 back-dated). Unique findings so we can
# assert exactly which one the most-recent card shows.
CASES = {
    "Bloods": (f"BLD1{SUFFIX}", f"BLD2{SUFFIX}", f"BLD3{SUFFIX}"),
    "CXR": (f"CXR1{SUFFIX}", f"CXR2{SUFFIX}", f"CXR3{SUFFIX}"),
    "CT chest": (f"CT1{SUFFIX}", f"CT2{SUFFIX}", f"CT3{SUFFIX}"),
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


def add_result(page, patient_id, category, findings, result_at):
    r = page.evaluate(
        CALL_SERVER_FN,
        {
            "module": INV_MODULE,
            "name": "addInvestigation",
            "data": {
                "patient_id": patient_id,
                "category": category,
                "findings": findings,
                "result_at": result_at.isoformat(),
            },
        },
    )
    assert r["ok"], f"recording {category} '{findings}' failed: {r.get('error')}"


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
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- Record MULTIPLE results per category, out of date order ----
            for category, (f1, f2, f3) in CASES.items():
                add_result(page, patient_id, category, f1, now - timedelta(days=2))  # older
                add_result(page, patient_id, category, f2, now)                       # NEWEST
                add_result(page, patient_id, category, f3, now - timedelta(days=5))   # back-dated

            # ---- Refresh so the tab re-fetches from the server ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- Investigations tab: each "Most recent {category}" shows #2 ----
            inv_tab = page.get_by_role("tab", name="Investigations")
            inv_tab.scroll_into_view_if_needed()
            inv_tab.click()
            expect(inv_tab).to_have_attribute("data-state", "active", timeout=10000)
            inv_panel = page.get_by_role("tabpanel")
            expect(page.get_by_role("heading", name="Most recent results")).to_be_visible(
                timeout=15000
            )

            failures = []
            for category, (f1, f2, f3) in CASES.items():
                card = inv_panel.get_by_text(f"Most recent {category}", exact=True).first
                expect(card).to_be_visible(timeout=10000)
                card_container = card.locator(
                    "xpath=ancestor::*[@data-slot='card' or contains(@class,'card')][1]"
                )
                # The newest-dated result (#2) must be shown.
                if card_container.get_by_text(f2, exact=False).count() == 0:
                    failures.append(f"{category}: most-recent card does not show newest {f2}")
                # The older (#1) and back-dated (#3) must NOT be the headline value.
                for gone, why in ((f1, "older"), (f3, "back-dated")):
                    if card_container.get_by_text(gone, exact=False).count() != 0:
                        failures.append(
                            f"{category}: most-recent card wrongly shows {why} {gone}"
                        )

            page.screenshot(path=str(SCREENSHOTS / "multi_most_recent_after_refresh.png"))
            browser.close()

        assert not failures, "Most-recent-per-category failures:\n  - " + "\n  - ".join(failures)

        print(
            "PASS: after recording multiple Bloods/CXR/CT chest results and refreshing, "
            "each 'Most recent' card shows the newest-dated result"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
