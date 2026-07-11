"""
End-to-end test: calling the patient and version API endpoints WITHOUT a session
returns no patient data, and no patient markers appear anywhere.

The app exposes patient/version data through two API surfaces, both of which must
refuse anonymous callers:

  A. Public bridge REST endpoints (src/routes/api/public/bridge/*) — reachable
     over plain HTTP but gated by a signed-actor check (authorize() in
     src/lib/api-bridge.server.ts). With no auth headers they return 401 and an
     error body only.

  B. Internal server functions (createServerFn) — patient reads in
     src/lib/patients.functions.ts and version reads in
     src/lib/handover-versions.functions.ts, all behind requireSupabaseAuth.
     With no session they reject as Unauthorized.

To make "no data leaks" meaningful, we first seed REAL sensitive content: a
marker-bearing patient and a saved handover version whose snapshot carries the
marker. Then, with NO session, we assert:

  1. Direct HTTP GET/POST to the bridge patient endpoints → 401, error-only body,
     no patient array, no markers.
  2. listPatients / getPatient (by seeded id) → Unauthorized, no markers.
  3. listHandoverVersions / getHandoverVersion (by seeded id) → Unauthorized,
     no markers.
  4. The rendered DOM after deep-linking to /patients and /patients/{id} carries
     no markers (redirected to /auth).

A throwaway patient + saved version are created and cleaned up via the Supabase
admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-version-api-no-session-no-leak.e2e.py
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
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

PATIENTS_MODULE = "/src/lib/patients.functions.ts"
VERSIONS_MODULE = "/src/lib/handover-versions.functions.ts"

STAMP = str(int(time.time()))
MARKER = f"APINOLEAK{STAMP}"
PATIENT_NAME = f"ApiSecret {MARKER}"
MANAGEMENT = f"Confidential management {MARKER}"
HOSPITAL_NUMBER = f"HN{STAMP}"
MARKERS = [MARKER, PATIENT_NAME, MANAGEMENT, HOSPITAL_NUMBER]

# Bridge endpoints that return clinical data — must reject anonymous callers.
BRIDGE_GET_PATHS = [
    "/api/public/bridge/patients",
    "/api/public/bridge/patients?status=admitted",
    "/api/public/bridge/investigations",
    "/api/public/bridge/microbiology",
]


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
            "age": 57,
            "hospital_number": HOSPITAL_NUMBER,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "6",
            "status": "admitted",
            "current_management": MANAGEMENT,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def create_version(patient_row):
    today = datetime.now(timezone.utc).date().isoformat()
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": today,
            "shift": "am",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "label": f"Seed version {MARKER}",
            "patient_count": 1,
            "snapshot": [patient_row],
            "search_text": f"{PATIENT_NAME} {MANAGEMENT} {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def cleanup(patient_id, version_id):
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


def assert_no_markers(haystack, where):
    for m in MARKERS:
        assert m not in haystack, f"{where} leaked marker {m!r}"


def main():
    patient_id = version_id = None
    try:
        patient = create_patient()
        patient_id = patient["id"]
        version_id = create_version(patient)

        # ---- A. Bridge REST endpoints over plain HTTP, no auth headers ----
        for path in BRIDGE_GET_PATHS:
            r = requests.get(f"{BASE_URL}{path}", timeout=30)
            assert r.status_code == 401, (
                f"GET {path} without auth returned {r.status_code}, expected 401"
            )
            body = r.text
            assert_no_markers(body, f"GET {path} body")
            # Never a populated patient/investigation collection.
            try:
                parsed = r.json()
            except ValueError:
                parsed = {}
            assert not parsed.get("patients"), f"GET {path} leaked a patients array"
            assert not parsed.get("investigations"), f"GET {path} leaked investigations"
            assert not parsed.get("microbiology"), f"GET {path} leaked microbiology"

        # A write attempt (upsert) must also be refused, not just reads.
        w = requests.post(
            f"{BASE_URL}/api/public/bridge/patients",
            json={"full_name": PATIENT_NAME},
            timeout=30,
        )
        assert w.status_code == 401, (
            f"POST bridge/patients without auth returned {w.status_code}, expected 401"
        )
        assert_no_markers(w.text, "POST bridge/patients body")
        print("OK  bridge patient endpoints reject anonymous callers with 401, no data")

        # ---- B/C/D. Server fns + rendered DOM, no session ----
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # Never authenticate. Land on the public /auth page and let it settle
            # so no in-flight redirect destroys the evaluate execution context.
            page.goto(f"{BASE_URL}/auth", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            def reject(module, name, data=None, label=""):
                out = page.evaluate(
                    CALL_FN, {"module": module, "name": name, "data": data}
                )
                assert not out["ok"], f"{label or name} succeeded without a session"
                assert "unauthor" in out["error"].lower(), (
                    f"{label or name} rejected but not for auth: {out['error']}"
                )
                assert_no_markers(json.dumps(out), f"{label or name} result/error")

            # Patient API (version B)
            reject(PATIENTS_MODULE, "listPatients", None, "listPatients")
            reject(PATIENTS_MODULE, "getPatient", {"id": patient_id}, "getPatient")

            # Version API (version C)
            reject(VERSIONS_MODULE, "listHandoverVersions", {}, "listHandoverVersions")
            reject(
                VERSIONS_MODULE,
                "listHandoverVersions",
                {"q": MARKER},
                "listHandoverVersions(marker search)",
            )
            reject(
                VERSIONS_MODULE,
                "getHandoverVersion",
                {"id": version_id},
                "getHandoverVersion",
            )
            print("OK  patient + version server functions reject without a session")

            # ---- D. Deep-linked pages redirect to /auth and leak nothing ----
            for path in (f"/patients", f"/patients/{patient_id}", "/patients/history"):
                page.goto(f"{BASE_URL}{path}", wait_until="domcontentloaded")
                page.wait_for_url("**/auth", timeout=15000)
                page.wait_for_load_state("networkidle")
                assert_no_markers(page.content(), f"DOM after deep-link {path}")
            page.screenshot(
                path=str(SCREENSHOTS / "patient_version_api_no_session_no_leak.png")
            )
            print("OK  deep-linked patient/history routes redirect to /auth, no markers")

            browser.close()

        print(
            "PASS: patient + version API endpoints return no data without a session "
            "and no patient markers appear anywhere"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
