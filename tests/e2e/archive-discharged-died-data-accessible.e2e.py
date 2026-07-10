"""
End-to-end test: discharged AND died patients drop out of the current patient
board and appear in the Archive view, while their investigations and summaries
remain fully accessible and correct.

Records retained after discharge/death are never hard-deleted (see project
lifecycle rules). This test proves the Archive UX and data integrity end-to-end
through the app's genuine TanStack server-function RPC client and the real UI:

  Setup (as an authenticated clinician):
    - Patient A "admitted" with a Bloods investigation, then DISCHARGED
      (destination + discharge date).
    - Patient B "admitted" with a CT chest investigation, then marked DIED
      (date of death).

  1. CURRENT BOARD  — on the default board neither A nor B is listed (both are
     terminal/archived), and an active control patient IS listed.
  2. ARCHIVE VIEW   — click "Archive"; both A and B now appear with the correct
     "Discharged" / "Died" status badges, and the active control patient is gone.
  3. DETAIL + DATA  — open each archived record and confirm:
       * the record renders (name + terminal status badge),
       * the Investigations tab shows the "Most recent {category}" summary with
         the recorded finding (summaries remain correct after archiving),
       * the Overview "Most recent investigations" card shows the same finding.

Throwaway clinician user + patients are created and removed via the Supabase
admin REST API so nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/archive-discharged-died-data-accessible.e2e.py
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
PATIENTS_MODULE = "/src/lib/patients.functions.ts"
INV_MODULE = "/src/lib/investigations.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EARCH{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"

# Unique full_name markers so we can find each card unambiguously on the board.
NAME_DISCHARGED = f"AX-DISCH-{MARKER}"
NAME_DIED = f"AX-DIED-{MARKER}"
NAME_ACTIVE = f"AX-LIVE-{MARKER}"

BLOODS_FINDING = f"Hb-108-{MARKER}"
CT_FINDING = f"CT-no-PE-{MARKER}"

DEST = f"Ward 7 {MARKER}"


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


def create_patient(name):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "age": 70,
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


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        if not pid:
            continue
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{pid}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
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


def add_investigation(page, patient_id, category, findings):
    r = call_fn(page, INV_MODULE, "addInvestigation", {
        "patient_id": patient_id,
        "category": category,
        "findings": findings,
        "result_at": datetime.now(timezone.utc).isoformat(),
    })
    assert r["ok"], f"adding {category} failed: {r.get('error')}"


def update_patient(page, data):
    r = call_fn(page, PATIENTS_MODULE, "updatePatient", data)
    assert r["ok"], f"updatePatient failed: {r.get('error')}"


def goto_board(page):
    page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"


def toggle_archive(page):
    page.get_by_role("button", name="Archive").click()
    expect(page.get_by_text("Discharged & deceased records")).to_be_visible(timeout=10000)


def verify_detail_and_data(page, patient_id, name, status_label, category, finding):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"
    expect(page.get_by_text(name, exact=False).first).to_be_visible(timeout=15000)
    # Terminal status badge present in the header.
    expect(page.get_by_text(status_label, exact=False).first).to_be_visible(timeout=10000)

    # Investigations tab: "Most recent {category}" summary shows the finding.
    inv_tab = page.get_by_role("tab", name="Investigations")
    inv_tab.scroll_into_view_if_needed()
    inv_tab.click()
    expect(inv_tab).to_have_attribute("data-state", "active", timeout=10000)
    inv_panel = page.get_by_role("tabpanel")
    card = inv_panel.get_by_text(f"Most recent {category}", exact=True).first
    expect(card).to_be_visible(timeout=15000)
    expect(inv_panel.get_by_text(finding, exact=False).first).to_be_visible(timeout=10000)

    # Overview "Most recent investigations" summary shows the same finding.
    ov_tab = page.get_by_role("tab", name="Overview")
    ov_tab.scroll_into_view_if_needed()
    ov_tab.click()
    expect(ov_tab).to_have_attribute("data-state", "active", timeout=10000)
    ov_panel = page.get_by_role("tabpanel")
    expect(page.get_by_text("Most recent investigations", exact=True)).to_be_visible(
        timeout=15000
    )
    expect(ov_panel.get_by_text(finding, exact=False).first).to_be_visible(timeout=10000)


def main():
    user_id = None
    pid_disch = pid_died = pid_active = None
    try:
        user_id, email = create_user()
        pid_disch = create_patient(NAME_DISCHARGED)
        pid_died = create_patient(NAME_DIED)
        pid_active = create_patient(NAME_ACTIVE)
        session = sign_in(email)
        today = datetime.now(timezone.utc).date().isoformat()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            goto_board(page)

            # ---- Setup: investigations, then terminal statuses ----
            add_investigation(page, pid_disch, "Bloods", BLOODS_FINDING)
            add_investigation(page, pid_died, "CT chest", CT_FINDING)

            update_patient(page, {
                "id": pid_disch,
                "status": "discharged",
                "discharge_date": today,
                "discharge_destination": DEST,
            })
            update_patient(page, {
                "id": pid_died,
                "status": "died",
                "date_of_death": today,
            })
            assert read_status(pid_disch) == "discharged"
            assert read_status(pid_died) == "died"

            # ---- 1. CURRENT BOARD: terminal patients hidden, active shown ----
            goto_board(page)
            expect(page.get_by_text(NAME_ACTIVE, exact=False).first).to_be_visible(
                timeout=15000
            )
            assert page.get_by_text(NAME_DISCHARGED, exact=False).count() == 0, (
                "discharged patient should NOT show on the current board"
            )
            assert page.get_by_text(NAME_DIED, exact=False).count() == 0, (
                "died patient should NOT show on the current board"
            )
            page.screenshot(path=str(SCREENSHOTS / "archive_current_board.png"))

            # ---- 2. ARCHIVE VIEW: terminal patients shown, active hidden ----
            toggle_archive(page)
            expect(page.get_by_text(NAME_DISCHARGED, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_text(NAME_DIED, exact=False).first).to_be_visible(
                timeout=15000
            )
            assert page.get_by_text(NAME_ACTIVE, exact=False).count() == 0, (
                "active patient should NOT show in the Archive view"
            )
            # Correct status badges are present in the archive.
            expect(page.get_by_text("Discharged", exact=False).first).to_be_visible(
                timeout=10000
            )
            expect(page.get_by_text("Died", exact=False).first).to_be_visible(
                timeout=10000
            )
            page.screenshot(path=str(SCREENSHOTS / "archive_view.png"))

            # ---- 3. DETAIL + DATA still accessible and correct ----
            verify_detail_and_data(
                page, pid_disch, NAME_DISCHARGED, "Discharged", "Bloods", BLOODS_FINDING
            )
            page.screenshot(path=str(SCREENSHOTS / "archive_discharged_detail.png"))
            verify_detail_and_data(
                page, pid_died, NAME_DIED, "Died", "CT chest", CT_FINDING
            )
            page.screenshot(path=str(SCREENSHOTS / "archive_died_detail.png"))

            browser.close()

        print(
            "PASS: discharged & died patients move to Archive while investigations "
            "and summaries remain accessible and correct"
        )
        return 0
    finally:
        cleanup([pid_disch, pid_died, pid_active], user_id)


if __name__ == "__main__":
    sys.exit(main())
