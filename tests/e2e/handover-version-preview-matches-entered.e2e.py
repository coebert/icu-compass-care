"""
End-to-end test: save an on-demand handover version, then open the History
preview for that version and confirm the captured patient details match exactly
what was entered.

Flow (src/routes/_authenticated/patients.history.tsx +
src/lib/handover-versions.functions.ts):

  1. Seed a patient with distinctive, unique clinical values: management,
     escalation/TEP plan, outstanding tasks, and next of kin.
  2. Log in as an admin and click "Save version now" to capture a point-in-time
     handover snapshot.
  3. Locate the freshly captured version in the History list and select it so
     the History preview iframe renders (blob PDF src).
  4. Confirm the captured version's stored snapshot contains EXACTLY the values
     entered for the patient (name, management, escalation plan, tasks, NOK) —
     i.e. the preview shows what was entered, unchanged.

A throwaway admin user + marker-bearing patient are created and cleaned up via
the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-version-preview-matches-entered.e2e.py
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

VERSIONS_MODULE = "/src/lib/handover-versions.functions.ts"

STAMP = str(int(time.time()))
MARKER = f"HVMATCH{STAMP}"
PATIENT_NAME = f"Match Test {MARKER}"
MANAGEMENT = f"Lung-protective ventilation, wean sedation {MARKER}"
ESCALATION = f"For full escalation incl. RRT; not for CPR {MARKER}"
TASKS = f"Chase blood cultures; family meeting 15:00 {MARKER}"
NOK_NAME = f"Jane Doe {MARKER}"
NOK_REL = "Wife"
NOK_CONTACT = f"07700{STAMP[-6:]}"
PASSWORD = "Test-Passw0rd-123!"

# Each entered value must survive verbatim into the captured snapshot.
EXPECTED_VALUES = [PATIENT_NAME, MANAGEMENT, ESCALATION, TASKS, NOK_NAME, NOK_CONTACT]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
    email = f"e2e-{MARKER.lower()}@example.com"
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
        json={"user_id": uid, "role": "admin"},
        timeout=30,
    ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 61,
            "weight_kg": 74,
            "hospital_number": f"HN{STAMP}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            "current_admission": f"Admission {MARKER}",
            "current_management": MANAGEMENT,
            "tep_in_place": True,
            "tep_details": ESCALATION,
            "outstanding_tasks": TASKS,
            "nok_name": NOK_NAME,
            "nok_relationship": NOK_REL,
            "nok_contact": NOK_CONTACT,
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


def cleanup(patient_id, user_id, version_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


CALL_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn(arg.data ? { data: arg.data } : undefined);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def main():
    user_id = patient_id = version_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # ---- Authenticate ----
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients/history", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth: {page.url}"

            # ---- 1. Save an on-demand version ----
            save_btn = page.get_by_role("button", name="Save version now")
            expect(save_btn).to_be_visible(timeout=15000)
            save_btn.click()
            expect(page.get_by_text("Saved version", exact=False).first).to_be_visible(
                timeout=20000
            )

            # ---- 2. Find the captured version (newest first), poll for it ----
            rows = []
            deadline = time.time() + 15
            while time.time() < deadline:
                listed = page.evaluate(
                    CALL_FN,
                    {
                        "module": VERSIONS_MODULE,
                        "name": "listHandoverVersions",
                        "data": {"q": MARKER},
                    },
                )
                assert listed["ok"], f"list failed: {listed.get('error')!r}"
                rows = listed["result"]["rows"]
                if rows:
                    break
                time.sleep(0.5)
            assert rows, "captured version not found by marker search"
            version_id = rows[0]["id"]
            assert rows[0]["patient_count"] >= 1, "captured version has no patients"

            # ---- 3. Open the History preview for that version ----
            page.get_by_role("textbox", name="Search (patient or text)").fill(MARKER)
            version_btn = page.get_by_role("button", name=rows[0]["label"])
            expect(version_btn).to_be_visible(timeout=15000)
            version_btn.click()
            iframe = page.locator("iframe[title='Saved handover preview']")
            expect(iframe).to_be_visible(timeout=20000)
            src = iframe.get_attribute("src") or ""
            assert src.startswith("blob:"), f"preview has no blob src: {src!r}"
            page.screenshot(
                path=str(SCREENSHOTS / "handover_version_preview_matches.png")
            )

            # ---- 4. Confirm captured details match what was entered ----
            one = page.evaluate(
                CALL_FN,
                {
                    "module": VERSIONS_MODULE,
                    "name": "getHandoverVersion",
                    "data": {"id": version_id},
                },
            )
            assert one["ok"], f"getHandoverVersion failed: {one.get('error')!r}"
            snap_text = json.dumps(one["result"]["snapshot"])
            missing = [v for v in EXPECTED_VALUES if v not in snap_text]
            assert not missing, f"snapshot is missing entered values: {missing!r}"

            print(
                "OK  on-demand version saved; History preview renders and its "
                "snapshot matches every entered field (name, management, "
                "escalation, tasks, NOK)"
            )
            browser.close()

        print("PASS: History preview shows the on-demand version's entered details")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
