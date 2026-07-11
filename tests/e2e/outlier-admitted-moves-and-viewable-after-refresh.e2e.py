"""
End-to-end test: create a patient on an OUTLYING ward via the app's real
create path, promote their status referred -> admitted, hard-refresh the board,
and verify the record "moves" correctly — it stays grouped under the outlying
wards / referrals context (never jumps into an ICU bed), keeps its ward label,
and remains viewable on its detail page with full outlying-ward context.

Why this shape:
  - Both `referred` and `admitted` are "active" states, so an admitted outlier
    must remain on the CURRENT board (not the Archive tab) and must stay in the
    "Outlying wards / referrals" section — grouping is by location_type, not
    status (see src/routes/_authenticated/patients.index.tsx). This test guards
    that an admitted outlier does not leak into the ICU bed board.
  - Uses the genuine TanStack server-function RPC path (createPatient +
    updatePatient in src/lib/patients.functions.ts) — the same code the UI runs.

Steps:
  1. CREATE (outlier, referred) via createPatient server fn; confirm DB + that
     the card renders under "Outlying wards / referrals" as "Referred".
  2. ADMIT (referred -> admitted) via updatePatient; confirm DB.
  3. RELOAD board — card still under "Outlying wards / referrals", now
     "Admitted", ward label visible, and absent from the ICU bed board.
  4. DETAIL — open /patients/{id}; record viewable with ward context + status.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/outlier-admitted-moves-and-viewable-after-refresh.e2e.py
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-OUTMOVE-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.M. Admit"
WARD = f"Radnor Ward {MARKER}"
BED = "7"


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


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,location_type,ward,bed",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_patient_id_by_marker():
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?ward=eq.{urllib.parse.quote(WARD)}&select=id",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0]["id"] if rows else None


def cleanup(patient_id, user_id):
    if patient_id:
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
        CALL_SERVER_FN, {"module": FUNCTIONS_MODULE, "name": name, "data": data}
    )


def outlier_section(page):
    # The card grid that follows the "Outlying wards / referrals" heading.
    return page.locator(
        "xpath=//h2[contains(., 'Outlying wards')]/following-sibling::div[1]"
    )


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
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
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"

            # ---- 1. CREATE the outlier via the real server function ----
            created = call_fn(page, "createPatient", {
                "full_name": PATIENT_NAME,
                "age": 71,
                "location_type": "outlier",
                "ward": WARD,
                "bed": BED,
                "status": "referred",
                "isolation_required": False,
                "tep_in_place": False,
                "dnacpr_decision": False,
                "current_management": f"Outlier awaiting bed {MARKER}",
            })
            assert created["ok"], f"createPatient should succeed: {created.get('error')}"
            patient_id = created["result"]["id"]

            start = read_patient(patient_id)
            assert start["status"] == "referred", f"start status: {start['status']!r}"
            assert start["location_type"] == "outlier", (
                f"expected outlier, got {start['location_type']!r}"
            )
            assert start["ward"] == WARD, f"ward not stored: {start['ward']!r}"

            # Board shows it under the outlying section as "Referred".
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            sect = outlier_section(page)
            card = sect.get_by_text(PATIENT_NAME, exact=False).first
            expect(card).to_be_visible(timeout=15000)
            expect(sect.get_by_text("Referred", exact=False).first).to_be_visible(
                timeout=10000
            )

            # ---- 2. ADMIT: referred -> admitted ----
            adm = call_fn(page, "updatePatient", {"id": patient_id, "status": "admitted"})
            assert adm["ok"], f"admit should succeed: {adm.get('error')}"
            after = read_patient(patient_id)
            assert after["status"] == "admitted", f"status not admitted: {after['status']!r}"
            assert after["location_type"] == "outlier", "location_type changed on admit"
            assert after["ward"] == WARD, "ward lost through admission"

            # ---- 3. RELOAD: record moved to Admitted but stays in outlier context ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"

            sect = outlier_section(page)
            card = sect.get_by_text(PATIENT_NAME, exact=False).first
            expect(card).to_be_visible(timeout=15000)
            # Now labelled Admitted, still under the outlying wards section.
            expect(sect.get_by_text("Admitted", exact=False).first).to_be_visible(
                timeout=10000
            )
            # Ward label still visible in the outlier context.
            expect(sect.get_by_text(WARD, exact=False).first).to_be_visible(timeout=10000)

            # Guard: an admitted outlier must NOT appear in an ICU bed slot.
            bed_board = page.locator(
                "xpath=//*[contains(text(),'ICU') or contains(text(),'Bed')]"
            )
            icu_leak = page.locator(
                "xpath=//h2[contains(., 'ICU')]/following-sibling::div[1]"
            ).get_by_text(PATIENT_NAME, exact=False)
            assert icu_leak.count() == 0, "admitted outlier leaked into ICU section"

            # Still on the CURRENT board (active), not archived.
            page.screenshot(
                path=str(SCREENSHOTS / "outlier_admitted_board_after_reload.png")
            )

            # ---- 4. DETAIL: viewable with full outlying-ward context ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"detail bounced to /auth: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_text(WARD, exact=False).first).to_be_visible(timeout=10000)
            expect(page.get_by_text("Admitted", exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(
                path=str(SCREENSHOTS / "outlier_admitted_detail_after_reload.png")
            )

            browser.close()

        print(
            "PASS: outlier created + admitted; record stays in outlying-ward "
            "context after refresh, never leaks to ICU, and remains viewable"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if patient_id is None:
            patient_id = find_patient_id_by_marker()
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
