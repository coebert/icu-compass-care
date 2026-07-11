"""
End-to-end test (UI-driven): create an OUTLYING-WARD (referred) patient, change
their status to "admitted" through the real Status-tab form, hard-refresh, and
verify the record and the Timeline events update correctly.

What it proves:
  1. CREATE   — a referred outlier is created via the genuine createPatient
                server fn; DB shows status=referred, location_type=outlier.
  2. ADMIT    — via the Status tab UI, status is changed to Admitted; DB shows
                status=admitted while location_type stays outlier and the ward
                label is retained (an admitted outlier is still an outlier).
  3. REFRESH  — after a hard reload the detail record still shows the ward and
                the Admitted status (no bounce to /auth, no data loss).
  4. TIMELINE — the Timeline tab shows a "Status changed to Admitted" event
                (derived from the record_audit status history) AND the
                "Admitted to critical care" admission event.

The referred->admitted change is recorded in record_audit by updatePatient and
surfaced by getPatientStatusChanges, which the TimelineTab renders.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/outlier-referred-to-admitted-record-timeline-refresh.e2e.py
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

MARKER = f"E2E-OUT2ADM-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.A. Ref"
WARD = f"Radnor Ward {MARKER}"
BED = "9"


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


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


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

            # ---- 1. CREATE the referred outlier via the real server function ----
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

            # ---- 2. ADMIT via the Status tab UI (referred -> admitted) ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"detail bounced to /auth: {page.url}"

            panel = open_status_tab(page)
            panel.get_by_role("combobox").click()
            page.get_by_role("option", name="Admitted", exact=True).click()
            panel.get_by_role("button", name="Update status").click()
            expect(page.get_by_text("Status updated")).to_be_visible(timeout=10000)

            after = read_patient(patient_id)
            assert after["status"] == "admitted", f"status not admitted: {after['status']!r}"
            assert after["location_type"] == "outlier", "location_type changed on admit"
            assert after["ward"] == WARD, "ward lost through admission"

            # ---- 3. REFRESH — record still viewable with ward + Admitted ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_text(WARD, exact=False).first).to_be_visible(timeout=10000)

            # ---- 4. TIMELINE — status-change + admission events present ----
            tab = page.get_by_role("tab", name="Timeline")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            tl = page.get_by_role("tabpanel")

            expect(
                tl.get_by_text("Status changed to Admitted", exact=False).first
            ).to_be_visible(timeout=15000)
            expect(
                tl.get_by_text("Admitted to critical care", exact=False).first
            ).to_be_visible(timeout=10000)

            titles = tl.locator("ol li").all_inner_texts()
            joined = "\n---\n".join(titles)
            assert any("Status changed to Admitted" in t for t in titles), (
                f"no 'Status changed to Admitted' timeline item:\n{joined}"
            )

            page.screenshot(path=str(SCREENSHOTS / "outlier_referred_to_admitted_timeline.png"))
            browser.close()

        print(
            "PASS: referred outlier admitted via the UI — record kept its outlier ward "
            "context and Admitted status, and the Timeline shows the status-change + "
            "admission events after refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
