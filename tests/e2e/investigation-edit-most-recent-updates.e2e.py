"""
End-to-end test: EDITING an existing investigation result — including changing
its result date — makes the "most recent" summary widgets update correctly.

The other investigation tests cover *adding* rows. This one focuses on the edit
path: the same finding row is mutated (findings text AND result_at) and the
"most recent" surfaces must recompute which finding is newest.

Scenario (category: Bloods):
  Seed two results through the app's genuine RPC client
  (addInvestigation in src/lib/investigations.functions.ts):
    - OLD  finding, dated 3 days ago
    - NEW  finding, dated now  → most-recent shows NEW.

  1. EDIT-DATE-FORWARD — edit the OLD row, bumping its result_at to now + 1 day
     AND changing its findings text. Reload → most-recent flips to the edited
     row (new text) and no longer shows NEW.
  2. EDIT-TEXT-ONLY    — edit the same (now-newest) row's findings text again,
     leaving its date alone. Reload → most-recent shows the latest text.
  3. EDIT-DATE-BACK    — back-date that row to 5 days ago. Reload → most-recent
     flips back to NEW (the untouched row is now the newest again) and no
     longer shows the back-dated row's text.

Verified on BOTH surfaces: the Overview "Most recent investigations" card and
the Investigations tab "Most recent Bloods" card. Edits go through the app's
genuine updateInvestigation RPC — the same path the Edit-result dialog uses.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigation-edit-most-recent-updates.e2e.py
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

MARKER = f"E2EEDMR{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "E.D.M."
CATEGORY = "Bloods"

SUFFIX = str(int(time.time()))[-6:]
OLD_TXT = f"OLD-Hb-72-{SUFFIX}"
NEW_TXT = f"NEW-Hb-118-{SUFFIX}"
EDIT1_TXT = f"EDIT1-Hb-95-{SUFFIX}"   # OLD row edited, moved to newest
EDIT2_TXT = f"EDIT2-Hb-101-{SUFFIX}"  # same row, text changed again


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


def add_result(page, patient_id, findings, result_at):
    r = call_fn(page, "addInvestigation", {
        "patient_id": patient_id,
        "category": CATEGORY,
        "findings": findings,
        "result_at": result_at.isoformat(),
    })
    assert r["ok"], f"recording '{findings}' failed: {r.get('error')}"
    return r["result"]["id"]


def edit_result(page, inv_id, findings, result_at):
    r = call_fn(page, "updateInvestigation", {
        "id": inv_id,
        "category": CATEGORY,
        "findings": findings,
        "result_at": result_at.isoformat(),
    })
    assert r["ok"], f"editing '{findings}' failed: {r.get('error')}"


def reload_authed(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"


def assert_most_recent(page, shown, absent, phase):
    """Assert both most-recent surfaces show `shown` and never show any string
    in `absent`."""
    # --- Overview "Most recent investigations" card ---
    overview_tab = page.get_by_role("tab", name="Overview")
    overview_tab.scroll_into_view_if_needed()
    overview_tab.click()
    expect(overview_tab).to_have_attribute("data-state", "active", timeout=10000)
    overview = page.get_by_role("tabpanel")
    expect(page.get_by_text("Most recent investigations", exact=True)).to_be_visible(
        timeout=15000
    )
    expect(overview.get_by_text(shown, exact=False)).to_be_visible(timeout=10000)
    for gone in absent:
        assert overview.get_by_text(gone, exact=False).count() == 0, (
            f"[{phase}] Overview wrongly shows {gone}"
        )

    # --- Investigations tab "Most recent Bloods" card ---
    inv_tab = page.get_by_role("tab", name="Investigations")
    inv_tab.scroll_into_view_if_needed()
    inv_tab.click()
    expect(inv_tab).to_have_attribute("data-state", "active", timeout=10000)
    inv_panel = page.get_by_role("tabpanel")
    card = inv_panel.get_by_text(f"Most recent {CATEGORY}", exact=True).first
    expect(card).to_be_visible(timeout=15000)
    expect(inv_panel.get_by_text(shown, exact=False).first).to_be_visible(timeout=10000)
    # Absence is scoped to the "Most recent Bloods" card only — the tab also
    # renders the full history where older findings legitimately still appear.
    card_container = card.locator(
        "xpath=ancestor::*[@data-slot='card' or contains(@class,'card')][1]"
    )
    for gone in absent:
        assert card_container.get_by_text(gone, exact=False).count() == 0, (
            f"[{phase}] 'Most recent {CATEGORY}' card wrongly shows {gone}"
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

            # ---- Seed: OLD (3 days ago) + NEW (now). Most recent = NEW ----
            old_id = add_result(page, patient_id, OLD_TXT, now - timedelta(days=3))
            add_result(page, patient_id, NEW_TXT, now)
            reload_authed(page)
            assert_most_recent(page, shown=NEW_TXT, absent=[OLD_TXT],
                               phase="seed")
            page.screenshot(path=str(SCREENSHOTS / "editmr_seed.png"))

            # ---- 1. EDIT the OLD row forward (date + text) → becomes newest ----
            edit_result(page, old_id, EDIT1_TXT, now + timedelta(days=1))
            reload_authed(page)
            assert_most_recent(page, shown=EDIT1_TXT, absent=[NEW_TXT, OLD_TXT],
                               phase="edit-date-forward")
            page.screenshot(path=str(SCREENSHOTS / "editmr_forward.png"))

            # ---- 2. EDIT same row's text only (keep newest date) ----
            edit_result(page, old_id, EDIT2_TXT, now + timedelta(days=1))
            reload_authed(page)
            assert_most_recent(page, shown=EDIT2_TXT,
                               absent=[EDIT1_TXT, NEW_TXT, OLD_TXT],
                               phase="edit-text-only")
            page.screenshot(path=str(SCREENSHOTS / "editmr_textonly.png"))

            # ---- 3. BACK-DATE that row → NEW becomes newest again ----
            edit_result(page, old_id, EDIT2_TXT, now - timedelta(days=5))
            reload_authed(page)
            assert_most_recent(page, shown=NEW_TXT, absent=[EDIT2_TXT, EDIT1_TXT],
                               phase="edit-date-back")
            page.screenshot(path=str(SCREENSHOTS / "editmr_back.png"))

            browser.close()

        print(
            "PASS: editing an investigation's date/findings correctly updates the "
            "most-recent Bloods summary on both surfaces"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
