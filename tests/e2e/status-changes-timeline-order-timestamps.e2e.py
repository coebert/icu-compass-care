"""
End-to-end test: driving a patient through MULTIPLE status changes and
verifying the Timeline tab renders the resulting audit events in the correct
chronological order (newest first) with the correct timestamps, and that this
survives a full page refresh.

The Timeline (TimelineTab in src/routes/_authenticated/patients.$patientId.tsx)
derives status events from the record:
  - "Admitted to critical care"  at admission_date (or created_at)
  - "Discharged"                 at discharge_date (when status == "discharged")
  - "Died"                       at date_of_death  (when status == "died")
and sorts every event by timestamp descending, so the most recent status change
appears at the top.

Lifecycle rules (src/lib/patient-schema.ts): referred -> admitted -> discharged
(discharged is terminal and requires a date + destination). This test performs
two real status transitions through the genuine updatePatient server function
(the same RPC the Status tab uses), with a distinct admission date and a later
discharge date so ordering is unambiguous.

Steps:
  1. Seed a REFERRED patient with admission_date = D1 (6 days ago).
  2. Sign in as a throwaway clinician.
  3. Transition referred -> admitted, then admitted -> discharged with
     discharge_date = D2 (today) via updatePatient.
  4. Read the DB — confirm status=discharged and both dates stored.
  5. Hard-refresh, open the Timeline tab, and assert:
       - "Discharged" appears ABOVE "Admitted to critical care" (newest first),
       - the Discharged row shows D2's British date,
       - the Admitted row shows D1's British date.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/status-changes-timeline-order-timestamps.e2e.py
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2ETL{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "T.L. Order"  # <= 10 chars
DESTINATION = f"Ward{MARKER}"

NOW = datetime.now(timezone.utc)
D1 = (NOW.date() - timedelta(days=6)).isoformat()  # admission
D2 = NOW.date().isoformat()                          # discharge (today)


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
            "bed": "21",
            "status": "referred",
            "admission_date": D1,
            "current_admission": f"Admission note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,admission_date,discharge_date,discharge_destination",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


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


def uk(iso_date):
    return datetime.fromisoformat(iso_date).strftime("%d/%m/%Y")


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
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

            # ---- 1. Two real status transitions ----
            adm = call_fn(page, "updatePatient", {"id": patient_id, "status": "admitted"})
            assert adm["ok"], f"admit should succeed: {adm.get('error')}"
            disch = call_fn(page, "updatePatient", {
                "id": patient_id,
                "status": "discharged",
                "discharge_date": D2,
                "discharge_destination": DESTINATION,
            })
            assert disch["ok"], f"discharge should succeed: {disch.get('error')}"

            row = read_patient(patient_id)
            assert row["status"] == "discharged", f"status: {row['status']!r}"
            assert row["admission_date"] == D1, f"admission_date: {row['admission_date']!r}"
            assert row["discharge_date"] == D2, f"discharge_date: {row['discharge_date']!r}"

            # ---- 2. Refresh and inspect the Timeline ordering + timestamps ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"

            tab = page.get_by_role("tab", name="Timeline")
            tab.scroll_into_view_if_needed()
            tab.click()
            expect(tab).to_have_attribute("data-state", "active", timeout=10000)
            panel = page.get_by_role("tabpanel")

            discharged_row = panel.get_by_text("Discharged", exact=False).first
            admitted_row = panel.get_by_text("Admitted to critical care", exact=False).first
            expect(discharged_row).to_be_visible(timeout=10000)
            expect(admitted_row).to_be_visible(timeout=10000)

            # Ordering: the timeline is an <ol>; read item titles top-to-bottom
            # and confirm Discharged (newest) appears before Admitted (oldest).
            titles = panel.locator("ol li").all_inner_texts()
            joined = "\n---\n".join(titles)
            disch_idx = next(
                (i for i, t in enumerate(titles) if "Discharged" in t), None
            )
            adm_idx = next(
                (i for i, t in enumerate(titles) if "Admitted to critical care" in t),
                None,
            )
            assert disch_idx is not None, f"no Discharged item:\n{joined}"
            assert adm_idx is not None, f"no Admitted item:\n{joined}"
            assert disch_idx < adm_idx, (
                f"timeline order wrong: Discharged(idx {disch_idx}) should be above "
                f"Admitted(idx {adm_idx}):\n{joined}"
            )

            # Timestamps: each status event shows its own British-format date.
            assert uk(D2) in titles[disch_idx], (
                f"Discharged row missing date {uk(D2)}: {titles[disch_idx]!r}"
            )
            assert uk(D1) in titles[adm_idx], (
                f"Admitted row missing date {uk(D1)}: {titles[adm_idx]!r}"
            )
            # The dates are genuinely different, proving distinct timestamps.
            assert uk(D1) != uk(D2), "test dates must differ"

            page.screenshot(path=str(SCREENSHOTS / "timeline_status_order.png"))
            browser.close()

        print(
            "PASS: multiple status changes produced Timeline events in correct "
            "newest-first order with correct timestamps, persisting after refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
