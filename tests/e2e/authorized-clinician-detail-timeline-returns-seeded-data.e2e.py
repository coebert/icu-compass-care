"""
End-to-end test: an AUTHORIZED clinician sees the seeded patient's DETAIL and
TIMELINE endpoints return the data correctly and completely — no omissions.

This is the positive counterpart to the unauthorized-clinician denial test. It
seeds one patient with data on every surface, signs in as a clinician (a user
granted the `clinician` role), and calls the exact server functions the detail
screen and its Timeline tab use, asserting each returns the seeded values:

  - getPatient              → status, key notes (current_management,
                              past_medical_history, current_admission)
  - getPatientStatusChanges → a seeded status change (admitted → died)
  - listPatientEvents       → the seeded key event
  - listInvestigations      → the seeded investigation
  - listMicrobiology        → the seeded microbiology result

Every function is invoked through the app's genuine TanStack RPC client from a
browser context carrying the clinician's session, so this exercises the real
data path — route guard, bearer middleware, RLS, and all.

Throwaway user + patient (and child rows) are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/authorized-clinician-detail-timeline-returns-seeded-data.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
INV_MODULE = "/src/lib/investigations.functions.ts"
MICRO_MODULE = "/src/lib/microbiology.functions.ts"
EVENTS_MODULE = "/src/lib/patient-events.functions.ts"

MARKER = f"E2E-AUTH-READ-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "A.R."
DEATH_DATE = "2026-01-09"
MGMT_NOTE = f"Management {MARKER}"
PMH_NOTE = f"PMH {MARKER}"
ADMISSION_NOTE = f"Admission {MARKER}"
EVENT_NOTE = f"Event {MARKER}"
INV_NOTE = f"Investigation {MARKER}"
MICRO_NOTE = f"Micro {MARKER}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user(suffix, role=None):
    email = f"{MARKER.lower()}-{suffix}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    if role:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/user_roles",
            headers=admin_headers(),
            json={"user_id": uid, "role": role},
            timeout=30,
        ).raise_for_status()
    return uid, email


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "died",
            "date_of_death": DEATH_DATE,
            "current_management": MGMT_NOTE,
            "past_medical_history": PMH_NOTE,
            "current_admission": ADMISSION_NOTE,
        },
        timeout=30,
    )
    r.raise_for_status()
    pid = r.json()[0]["id"]
    # TIMELINE: a status change (admitted -> died) via record_audit.
    requests.post(
        f"{SUPABASE_URL}/rest/v1/record_audit",
        headers=admin_headers(),
        json={
            "entity": "patients",
            "record_id": pid,
            "action": "update",
            "source": "app",
            "changed_fields": ["status"],
            "before": {"status": "admitted"},
            "after": {"status": "died"},
        },
        timeout=30,
    ).raise_for_status()
    # TIMELINE: a key event.
    requests.post(
        f"{SUPABASE_URL}/rest/v1/patient_events",
        headers=admin_headers(),
        json={
            "patient_id": pid,
            "event_type": "Note",
            "description": EVENT_NOTE,
            "event_at": "2026-01-06T00:00:00Z",
        },
        timeout=30,
    ).raise_for_status()
    # INVESTIGATIONS: an investigation row.
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": pid,
            "category": "Bloods",
            "findings": INV_NOTE,
            "result_at": "2026-01-06T00:00:00Z",
        },
        timeout=30,
    ).raise_for_status()
    # INVESTIGATIONS: a microbiology row.
    requests.post(
        f"{SUPABASE_URL}/rest/v1/microbiology_results",
        headers=admin_headers(),
        json={
            "patient_id": pid,
            "specimen_type": "Blood culture",
            "findings": MICRO_NOTE,
            "result_at": "2026-01-06T00:00:00Z",
        },
        timeout=30,
    ).raise_for_status()
    return pid


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cleanup(patient_id, user_ids):
    if patient_id:
        for table in ("patient_events", "investigations", "microbiology_results"):
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}",
                headers=admin_headers(),
                timeout=30,
            )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/record_audit?record_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
    for uid in user_ids:
        if uid:
            requests.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{uid}",
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


def call(page, module, name, data):
    return page.evaluate(CALL_SERVER_FN, {"module": module, "name": name, "data": data})


def main():
    patient_id = None
    clin_uid = None
    try:
        clin_uid, clin_email = create_user("clinician", role="clinician")
        patient_id = create_patient()
        session = sign_in(clin_email)

        failures = []

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- DETAIL: getPatient returns status + key notes --------------
            detail = call(page, PATIENTS_MODULE, "getPatient", {"id": patient_id})
            if not detail["ok"] or not detail["result"]:
                failures.append(f"getPatient returned nothing: {detail}")
            else:
                p = detail["result"]
                checks = {
                    "status": (p.get("status"), "died"),
                    "date_of_death": (p.get("date_of_death"), DEATH_DATE),
                    "current_management": (p.get("current_management"), MGMT_NOTE),
                    "past_medical_history": (p.get("past_medical_history"), PMH_NOTE),
                    "current_admission": (p.get("current_admission"), ADMISSION_NOTE),
                    "full_name": (p.get("full_name"), PATIENT_NAME),
                }
                for field, (got, want) in checks.items():
                    if got != want:
                        failures.append(f"getPatient.{field}: got {got!r}, want {want!r}")

            # ---- TIMELINE: status changes -----------------------------------
            sc = call(page, PATIENTS_MODULE, "getPatientStatusChanges", {"id": patient_id})
            if not sc["ok"] or not sc["result"]:
                failures.append(f"getPatientStatusChanges returned nothing: {sc}")
            else:
                match = next(
                    (r for r in sc["result"] if r.get("from") == "admitted" and r.get("to") == "died"),
                    None,
                )
                if not match:
                    failures.append(f"status change admitted->died missing: {sc['result']}")

            # ---- TIMELINE: key events ---------------------------------------
            ev = call(page, EVENTS_MODULE, "listPatientEvents", {"patientId": patient_id})
            if not ev["ok"] or not any(
                r.get("description") == EVENT_NOTE for r in (ev.get("result") or [])
            ):
                failures.append(f"listPatientEvents missing seeded event: {ev}")

            # ---- INVESTIGATIONS ---------------------------------------------
            inv = call(page, INV_MODULE, "listInvestigations", {"patientId": patient_id})
            if not inv["ok"] or not any(
                r.get("findings") == INV_NOTE for r in (inv.get("result") or [])
            ):
                failures.append(f"listInvestigations missing seeded investigation: {inv}")

            micro = call(page, MICRO_MODULE, "listMicrobiology", {"patientId": patient_id})
            if not micro["ok"] or not any(
                r.get("findings") == MICRO_NOTE for r in (micro.get("result") or [])
            ):
                failures.append(f"listMicrobiology missing seeded micro result: {micro}")

            page.screenshot(path=str(SCREENSHOTS / "authorized_clinician_reads_seeded.png"))
            browser.close()

        assert not failures, "Authorized-read verification failures:\n  - " + "\n  - ".join(failures)

        print(
            "PASS: authorized clinician received full seeded data — status, key notes, "
            "status change, key event, investigation, and microbiology — with no omissions"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, [clin_uid])


if __name__ == "__main__":
    sys.exit(main())
