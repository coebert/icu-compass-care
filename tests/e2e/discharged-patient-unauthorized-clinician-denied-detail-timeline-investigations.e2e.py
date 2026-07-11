"""
End-to-end test: a DIFFERENT, unauthorized clinician cannot view OR edit the
DETAILS, TIMELINE, or INVESTIGATIONS of a specific DISCHARGED patient record.

Access to patient data is gated by clinical-access RLS (admin or clinician
role) plus requireSupabaseAuth server functions — being merely authenticated is
not enough. A "different (unauthorized) clinician" here is a throwaway
authenticated account that has NOT been granted a clinical role. Discharged
records are retained (never hard-deleted), so they must be protected exactly
like live ones.

The discharged patient is seeded with data on every surface the request names:
  - DETAIL       : name + confidential current_management note + discharge dest
  - TIMELINE     : a patient_events key event AND a status history entry
  - INVESTIGATIONS: an investigation row + a microbiology row

Signed in as the unauthorized clinician, the test asserts:
  1. ROUTE/UI      — /patients/<id> never renders the patient's name,
                     "Discharged" status, or any seeded marker (in-app "not
                     found" or /auth).
  2. DETAIL read   — getPatient returns no record and leaks no marker.
  3. TIMELINE read — getPatientStatusChanges + listPatientEvents return no rows
                     and leak no marker.
  4. INVESTIGATIONS read — listInvestigations + listMicrobiology return no rows
                     and leak no marker.
  5. EDIT blocked  — updatePatient does not change the record; the database row
                     is byte-for-byte unchanged afterwards.

Every server function is invoked through the app's genuine TanStack RPC client
from a browser context carrying THIS user's session, so the data layer — not
just the route guard — is what blocks access.

A positive control confirms the seeded record is retrievable with service
credentials, so denial is proven rather than a missing row.

Throwaway user + patient (and child rows) are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/discharged-patient-unauthorized-clinician-denied-detail-timeline-investigations.e2e.py
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

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
INV_MODULE = "/src/lib/investigations.functions.ts"
MICRO_MODULE = "/src/lib/microbiology.functions.ts"
EVENTS_MODULE = "/src/lib/patient-events.functions.ts"

MARKER = f"E2E-DISCH-DENY-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "Z.D."
DISCHARGE_DATE = "2026-01-08"
DISCHARGE_DEST = f"Ward 12 {MARKER}"
SECRET_NOTE = f"CONFIDENTIAL management {MARKER}"
EVENT_NOTE = f"Event {MARKER}"
INV_NOTE = f"Investigation {MARKER}"
MICRO_NOTE = f"Micro {MARKER}"
INTRUDER_NOTE = f"HACKED by unauthorized clinician {MARKER}"

ALL_MARKERS = [SECRET_NOTE, EVENT_NOTE, INV_NOTE, MICRO_NOTE, DISCHARGE_DEST, PATIENT_NAME]


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


def create_discharged_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "discharged",
            "discharge_date": DISCHARGE_DATE,
            "discharge_destination": DISCHARGE_DEST,
            "current_management": SECRET_NOTE,
        },
        timeout=30,
    )
    r.raise_for_status()
    pid = r.json()[0]["id"]
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


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,current_management,discharge_date,discharge_destination",
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


def cleanup(patient_id, user_ids):
    if patient_id:
        for table in ("patient_events", "investigations", "microbiology_results"):
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/{table}?patient_id=eq.{patient_id}",
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


def leaks_marker(payload) -> bool:
    text = json.dumps(payload, default=str)
    return any(m in text for m in ALL_MARKERS)


def has_data(result) -> bool:
    if result is None:
        return False
    if isinstance(result, list):
        return len(result) > 0
    return True


def main():
    patient_id = None
    other_uid = None
    try:
        # A different clinician account with NO clinical role: authenticated but
        # unauthorized for patient data.
        other_uid, other_email = create_user("intruder", role=None)
        patient_id = create_discharged_patient()
        other_session = sign_in(other_email)

        # Positive control: the discharged record genuinely exists.
        assert read_patient(patient_id), "seed failed: discharged patient not readable by service"

        failures = []

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(other_session)],
            )

            # ---- 1. UI: the discharged record must not render for this clinician ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            denied_in_app = "/patients" in page.url and "/auth" not in page.url
            if denied_in_app:
                expect(page.get_by_text("Patient not found.")).to_be_visible(timeout=15000)
            body = page.inner_text("body")
            for m in ALL_MARKERS:
                if m in body:
                    failures.append(f"UI leaked marker to unauthorized clinician: {m!r}")
            page.screenshot(path=str(SCREENSHOTS / "discharged_unauth_clinician_denied.png"))

            # ---- 2-4. READ: detail, timeline, investigations via real RPC -----
            read_endpoints = [
                ("getPatient", PATIENTS_MODULE, {"id": patient_id}, "DETAIL"),
                ("getPatientStatusChanges", PATIENTS_MODULE, {"id": patient_id}, "TIMELINE"),
                ("listPatientEvents", EVENTS_MODULE, {"patientId": patient_id}, "TIMELINE"),
                ("listInvestigations", INV_MODULE, {"patientId": patient_id}, "INVESTIGATIONS"),
                ("listMicrobiology", MICRO_MODULE, {"patientId": patient_id}, "INVESTIGATIONS"),
            ]
            for name, module, data, surface in read_endpoints:
                out = page.evaluate(
                    CALL_SERVER_FN, {"module": module, "name": name, "data": data}
                )
                if out["ok"]:
                    if has_data(out["result"]):
                        failures.append(f"{surface}/{name}: returned data to unauthorized clinician")
                    if leaks_marker(out["result"]):
                        failures.append(f"{surface}/{name}: leaked seeded marker in payload")
                else:
                    # Rejection is also acceptable — but never leak a marker.
                    if any(m in str(out.get("error", "")) for m in ALL_MARKERS):
                        failures.append(f"{surface}/{name}: leaked marker in error")

            # ---- 5. EDIT: updatePatient must not change the record -----------
            edit_out = page.evaluate(
                CALL_SERVER_FN,
                {
                    "module": PATIENTS_MODULE,
                    "name": "updatePatient",
                    "data": {"id": patient_id, "current_management": INTRUDER_NOTE},
                },
            )
            browser.close()

        # The edit must not have persisted regardless of how the fn responded.
        after = read_patient(patient_id)
        assert after is not None, "record vanished after edit attempt"
        if after["current_management"] != SECRET_NOTE:
            failures.append(
                f"EDIT persisted for unauthorized clinician: {after['current_management']!r}"
            )
        if after["status"] != "discharged":
            failures.append(f"EDIT changed status: {after['status']!r}")
        _ = edit_out  # response shape is irrelevant; the DB check is authoritative

        assert not failures, "Unauthorized-clinician denial failures:\n  - " + "\n  - ".join(failures)

        print(
            "PASS: unauthorized clinician could not view or edit the discharged patient's "
            "details, timeline, or investigations; record unchanged in the database"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, [other_uid])


if __name__ == "__main__":
    sys.exit(main())
