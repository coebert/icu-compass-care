"""
End-to-end test: add Bloods, CXR, and CT chest investigations for a patient,
then confirm the "Most recent" investigation cards still render the correct
newest result for each category AFTER the patient is discharged AND after a full
page reload.

Clinical records (including investigations) are retained after discharge (see
src/lib/patients.functions.ts). The patient page shows "Most recent" widgets on
both the Overview tab ("Most recent investigations") and the Investigations tab
("Most recent {category}") — src/routes/_authenticated/patients.$patientId.tsx.

  1. SEED    — for each of Bloods / CXR / CT chest, add an OLDER result then a
               NEWER result via the app's addInvestigation server fn.
  2. DISCHARGE — move the patient to "discharged".
  3. RELOAD  — hard-reload /patients/{id}; confirm both surfaces show the NEWEST
               result per category and never the older one, for the discharged
               patient.

Results are recorded through the app's genuine TanStack server-function RPC
client (addInvestigation in src/lib/investigations.functions.ts) — the same
path the Add-result dialog uses.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/investigations-most-recent-after-discharge.e2e.py
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
PATIENTS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EMRDISCH{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "M.R.D. Discharge"

SUFFIX = str(int(time.time()))[-6:]
# Per category: (older result, newer result). Findings are unique so we can
# assert exactly which one the most-recent widget is showing.
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
            "age": 66,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_status(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}&select=status",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["status"]


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


def call_fn(page, module, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": module, "name": name, "data": data}
    )


def add_result(page, patient_id, category, findings, result_at):
    r = call_fn(page, INV_MODULE, "addInvestigation", {
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
    """Both most-recent surfaces show `expected_visible[category]` and never show
    any string in `expected_absent[category]`."""
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
        # Absence scoped to the dedicated "Most recent {category}" card — the tab
        # also renders a full history where older findings legitimately appear.
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
        today = now.date().isoformat()

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

            # ---- 1. SEED: older then newer per category (while admitted) ----
            for category, (older, newer) in CASES.items():
                add_result(page, patient_id, category, older, now - timedelta(days=2))
                add_result(page, patient_id, category, newer, now)

            # Sanity: before discharge the newest result already wins.
            reload_authed(page)
            assert_most_recent(
                page,
                expected_visible={c: v[1] for c, v in CASES.items()},
                expected_absent={c: [v[0]] for c, v in CASES.items()},
                phase="before discharge",
            )

            # ---- 2. DISCHARGE ----
            disch = call_fn(page, PATIENTS_MODULE, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": f"Ward 12 {MARKER}",
            })
            assert disch["ok"], f"discharge should succeed: {disch.get('error')}"
            assert read_status(patient_id) == "discharged", "status not discharged"

            # ---- 3. RELOAD: most-recent cards still correct after discharge ----
            reload_authed(page)
            assert_most_recent(
                page,
                expected_visible={c: v[1] for c, v in CASES.items()},
                expected_absent={c: [v[0]] for c, v in CASES.items()},
                phase="after discharge + reload",
            )
            page.screenshot(
                path=str(SCREENSHOTS / "investigations_most_recent_after_discharge.png")
            )

            browser.close()

        print(
            "PASS: most-recent Bloods/CXR/CT chest cards render the newest result "
            "per category after discharge and page reload"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
