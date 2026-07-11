"""
End-to-end test: while LOGGED OUT, directly invoking the patient DETAIL and
TIMELINE data endpoints is rejected for an auth reason and returns no data.

The detail screen (/patients/<id>) and its Timeline tab are fed entirely by
requireSupabaseAuth-guarded server functions. This test bypasses the UI and
calls those functions straight through the app's genuine TanStack RPC client
(the exact path the UI uses) from a browser context with NO session restored,
proving the data layer — not just the route guard — blocks unauthenticated
access.

Endpoints exercised (all must reject + leak nothing):
  - getPatient            (detail record)                 patients.functions.ts
  - listInvestigations    (Timeline investigations)       investigations.functions.ts
  - listMicrobiology      (Timeline microbiology)         microbiology.functions.ts
  - listPatientEvents     (Timeline key events)           patient-events.functions.ts
  - getPatientStatusChanges (Timeline status history)     patients.functions.ts

For each call it asserts:
  1. The call is rejected (ok === false).
  2. The rejection is for an AUTH reason (message contains "unauthor").
  3. No seeded marker data appears anywhere in the returned payload.

A throwaway patient carrying a unique marker note is created and cleaned up via
the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/loggedout-detail-timeline-endpoints-rejected.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
INV_MODULE = "/src/lib/investigations.functions.ts"
MICRO_MODULE = "/src/lib/microbiology.functions.ts"
EVENTS_MODULE = "/src/lib/patient-events.functions.ts"

MARKER = f"E2E-GUARD-DT-{int(time.time())}"
PATIENT_NAME = "G.T."


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": PATIENT_NAME,
            "age": 63,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Note {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    pid = r.json()[0]["id"]
    # Seed a Timeline key event so listPatientEvents would have a row to leak.
    requests.post(
        f"{SUPABASE_URL}/rest/v1/patient_events",
        headers=admin_headers(),
        json={
            "patient_id": pid,
            "event_type": "Note",
            "description": f"Event {MARKER}",
            "event_at": "2026-01-01T00:00:00Z",
        },
        timeout=30,
    ).raise_for_status()
    return pid


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patient_events?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
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


def main():
    patient_id = None
    try:
        patient_id = create_patient()

        endpoints = [
            ("getPatient", PATIENTS_MODULE, {"id": patient_id}),
            ("getPatientStatusChanges", PATIENTS_MODULE, {"id": patient_id}),
            ("listInvestigations", INV_MODULE, {"patientId": patient_id}),
            ("listMicrobiology", MICRO_MODULE, {"patientId": patient_id}),
            ("listPatientEvents", EVENTS_MODULE, {"patientId": patient_id}),
        ]

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # No session is ever restored — this caller is logged out.
            page.goto(BASE_URL, wait_until="domcontentloaded")

            failures = []
            for name, module, data in endpoints:
                outcome = page.evaluate(
                    CALL_SERVER_FN, {"module": module, "name": name, "data": data}
                )
                if outcome["ok"]:
                    failures.append(f"{name}: succeeded while logged out (data leaked)")
                    continue
                err = str(outcome.get("error", ""))
                if "unauthor" not in err.lower():
                    failures.append(f"{name}: rejected but not for an auth reason: {err}")
                if MARKER in err:
                    failures.append(f"{name}: seeded data leaked in error payload")

            page.screenshot(path=str(SCREENSHOTS / "loggedout_detail_timeline_rejected.png"))
            browser.close()

        assert not failures, "Endpoint guard failures:\n  - " + "\n  - ".join(failures)

        print(
            "PASS: logged-out getPatient, getPatientStatusChanges, listInvestigations, "
            "listMicrobiology and listPatientEvents were all rejected for an auth "
            "reason with no data returned"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
