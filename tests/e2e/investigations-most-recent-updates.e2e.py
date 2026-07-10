"""
End-to-end test: as investigations are added over time, the "most recent"
Bloods / CXR / CT chest views UPDATE correctly — always tracking the finding
with the newest result_at, regardless of the order rows are saved.

This complements:
  - recent-investigations-ordering.e2e.py (seeds rows via REST, checks Overview)
  - investigations-record-and-navigate.e2e.py (records old-then-new, checks the
    newest wins on both surfaces + tab navigation)

Here the focus is the *incremental update* of the most-recent widgets across
three saves per category, including an out-of-order (back-dated) save that must
NOT change the displayed value:

  For each category (Bloods / CXR / CT chest):
    A. Add result #1 (2 days ago). Reload → most-recent view shows #1.
    B. Add result #2 (now, newest). Reload → most-recent view flips to #2 and
       no longer shows #1.
    C. Add result #3 (5 days ago, back-dated / out of order). Reload → the
       most-recent view STILL shows #2 (a later-saved but older-dated result
       must not override the newest), and never shows #3.

  Verified on BOTH surfaces: the Overview "Most recent investigations" card and
  the Investigations tab's "Most recent {category}" cards.

Results are recorded through the app's genuine TanStack server-function RPC
client (addInvestigation in src/lib/investigations.functions.ts) — the same
path the Add-result dialog uses.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigations-most-recent-updates.e2e.py
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

MARKER = f"E2EMRUPD{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.R.U."

SUFFIX = str(int(time.time()))[-6:]
# Per category: (#1 first, #2 newest, #3 back-dated). Findings are unique so we
# can assert exactly which one the most-recent widget is showing.
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


def call_fn(page, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": INV_MODULE, "name": name, "data": data}
    )


def add_result(page, patient_id, category, findings, result_at):
    r = call_fn(page, "addInvestigation", {
        "patient_id": patient_id,
        "category": category,
        "findings": findings,
        "result_at": result_at.isoformat(),
    })
    assert r["ok"], f"recording {category} '{findings}' failed: {r.get('error')}"


def reload_authed(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"


def assert_most_recent(page, expected_visible, expected_absent, phase):
    """Assert both most-recent surfaces show `expected_visible[category]` and
    never show any string in `expected_absent[category]`."""
    # --- Overview "Most recent investigations" card ---
    overview_tab = page.get_by_role("tab", name="Overview")
    overview_tab.scroll_into_view_if_needed()
    overview_tab.click()
    expect(overview_tab).to_have_attribute("data-state", "active", timeout=10000)
    overview = page.get_by_role("tabpanel")
    expect(page.get_by_text("Most recent investigations", exact=True)).to_be_visible(
        timeout=15000
    )
    for category, shown in expected_visible.items():
        expect(overview.get_by_text(shown, exact=False)).to_be_visible(timeout=10000)
        for gone in expected_absent.get(category, []):
            assert overview.get_by_text(gone, exact=False).count() == 0, (
                f"[{phase}] Overview wrongly shows {category} value {gone}"
            )

    # --- Investigations tab "Most recent {category}" cards ---
    inv_tab = page.get_by_role("tab", name="Investigations")
    inv_tab.scroll_into_view_if_needed()
    inv_tab.click()
    expect(inv_tab).to_have_attribute("data-state", "active", timeout=10000)
    inv_panel = page.get_by_role("tabpanel")
    expect(page.get_by_role("heading", name="Most recent results")).to_be_visible(
        timeout=15000
    )
    for category, shown in expected_visible.items():
        card = inv_panel.get_by_text(f"Most recent {category}", exact=True).first
        expect(card).to_be_visible(timeout=10000)
        expect(inv_panel.get_by_text(shown, exact=False).first).to_be_visible(
            timeout=10000
        )
        # Absence is asserted only against the dedicated "Most recent {category}"
        # card (scoped to its container), not the whole Investigations tab — the
        # tab also renders a full result history where older/back-dated findings
        # legitimately still appear.
        card_container = card.locator(
            "xpath=ancestor::*[@data-slot='card' or contains(@class,'card')][1]"
        )
        for gone in expected_absent.get(category, []):
            assert card_container.get_by_text(gone, exact=False).count() == 0, (
                f"[{phase}] 'Most recent {category}' card wrongly shows value {gone}"
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
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- A. Add result #1 (2 days ago) for each category ----
            for category, (f1, _f2, _f3) in CASES.items():
                add_result(page, patient_id, category, f1, now - timedelta(days=2))
            reload_authed(page)
            assert_most_recent(
                page,
                expected_visible={c: v[0] for c, v in CASES.items()},
                expected_absent={},
                phase="A/after #1",
            )
            page.screenshot(path=str(SCREENSHOTS / "mrupd_after1.png"))

            # ---- B. Add result #2 (now, newest) — view must flip to #2 ----
            for category, (_f1, f2, _f3) in CASES.items():
                add_result(page, patient_id, category, f2, now)
            reload_authed(page)
            assert_most_recent(
                page,
                expected_visible={c: v[1] for c, v in CASES.items()},
                expected_absent={c: [v[0]] for c, v in CASES.items()},
                phase="B/after #2",
            )
            page.screenshot(path=str(SCREENSHOTS / "mrupd_after2.png"))

            # ---- C. Add result #3 (5 days ago, back-dated) — view must NOT change ----
            for category, (_f1, _f2, f3) in CASES.items():
                add_result(page, patient_id, category, f3, now - timedelta(days=5))
            reload_authed(page)
            assert_most_recent(
                page,
                expected_visible={c: v[1] for c, v in CASES.items()},
                expected_absent={c: [v[0], v[2]] for c, v in CASES.items()},
                phase="C/after back-dated #3",
            )
            page.screenshot(path=str(SCREENSHOTS / "mrupd_after3.png"))

            browser.close()

        print(
            "PASS: most-recent Bloods/CXR/CT chest widgets update correctly as "
            "results are added (newest wins, back-dated result ignored)"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
