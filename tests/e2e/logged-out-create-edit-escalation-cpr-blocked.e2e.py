"""
End-to-end test: while LOGGED OUT, attempting to create or edit a patient —
including updating the escalation plan (TEP) and CPR/DNACPR status — must be
sealed at both the UI and the data layer.

Two attack surfaces are exercised, both without any session:

  A. UI routes. The create UI lives on the board (/patients) and the edit UI
     (Edit dialog + TEP / DNACPR toggles) lives on the detail page
     (/patients/<id>). Logged out, each route must redirect to /auth, must NOT
     expose the create/edit affordances, and must contain NO seeded patient
     marker anywhere in the DOM (outerHTML + innerText + <title>).

  B. Data layer. A raw, unauthenticated attempt to flip the escalation/CPR
     status (PATCH patients.tep_in_place / dnacpr_decision via the Data API
     with only the publishable/anon key) must be rejected by RLS, and an
     independent admin read must confirm the row was NOT modified. An
     unauthenticated INSERT (create) must likewise fail.

A marker-bearing patient + throwaway clinician user are seeded and removed via
the Supabase admin REST API. No session is ever restored in the browser.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/logged-out-create-edit-escalation-cpr-blocked.e2e.py
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

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

STAMP = str(int(time.time()))
# Unique + unguessable so any DOM hit can only come from the seeded row.
NAME_MARKER = f"LoggedOutEdit{STAMP}"
HOSPITAL_MARKER = f"HN{STAMP}"
WARD_MARKER = f"WARD{STAMP}"
MGMT_MARKER = f"Mgmt{STAMP}"
TEP_MARKER = f"Tep{STAMP}"
DNACPR_MARKER = f"Dnacpr{STAMP}"

MARKERS = [
    NAME_MARKER,
    HOSPITAL_MARKER,
    WARD_MARKER,
    MGMT_MARKER,
    TEP_MARKER,
    DNACPR_MARKER,
]

# What an attacker would try to write, logged out.
INJECTED_TEP = f"Injected TEP {STAMP}"
INJECTED_DNACPR = f"Injected DNACPR {STAMP}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def anon_headers():
    return {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {PUBLISHABLE_KEY}",
        "Content-Type": "application/json",
    }


def create_patient():
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": NAME_MARKER,
            "age": 61,
            "hospital_number": HOSPITAL_MARKER,
            "location_type": "icu",
            "ward": WARD_MARKER,
            "status": "admitted",
            "current_management": MGMT_MARKER,
            "tep_in_place": True,
            "tep_details": TEP_MARKER,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_MARKER,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]["id"]


def read_row(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details,dnacpr_decision,dnacpr_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def cleanup(patient_id):
    if patient_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )


def find_leaks(page):
    """Return every seeded marker that appears anywhere in the current DOM."""
    haystack = page.evaluate(
        """() => [
             document.documentElement.outerHTML,
             document.body ? document.body.innerText : '',
             document.title,
           ].join('\\n')"""
    )
    return [m for m in MARKERS if m in haystack]


def assert_route_sealed(page, url, label, forbidden_controls):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_url("**/auth", timeout=15000)
    assert page.url.rstrip("/").endswith("/auth"), (
        f"[{label}] expected redirect to /auth, got {page.url}"
    )
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)

    # No create/edit affordances or patient tabs should be reachable.
    for role, name in forbidden_controls:
        assert not page.get_by_role(role, name=name).count(), (
            f"[{label}] '{name}' {role} rendered while logged out — edit/create UI leaked"
        )

    leaks = find_leaks(page)
    assert not leaks, (
        f"[{label}] patient data leaked into the DOM while logged out: {leaks}"
    )


def assert_data_layer_blocked(patient_id):
    # --- Attempt to flip escalation (TEP) + CPR (DNACPR) status, logged out ---
    patch = requests.patch(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}",
        headers={**anon_headers(), "Prefer": "return=representation"},
        json={
            "tep_in_place": False,
            "tep_details": INJECTED_TEP,
            "dnacpr_decision": False,
            "dnacpr_details": INJECTED_DNACPR,
        },
        timeout=30,
    )
    # RLS must not permit an anonymous write: either an error status, or a
    # success envelope that affected zero rows.
    if patch.status_code < 400:
        try:
            body = patch.json()
        except ValueError:
            body = None
        assert not body, (
            f"anonymous PATCH unexpectedly modified rows: {patch.status_code} {body}"
        )

    # --- Attempt to CREATE a patient, logged out ---
    ins = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**anon_headers(), "Prefer": "return=representation"},
        json={"full_name": f"AnonCreate{STAMP}", "age": 40, "status": "admitted"},
        timeout=30,
    )
    if ins.status_code < 400:
        try:
            created = ins.json()
        except ValueError:
            created = None
        assert not created, f"anonymous INSERT unexpectedly created a patient: {created}"

    # --- The escalation/CPR status must be exactly as seeded ---
    row = read_row(patient_id)
    assert row["tep_in_place"] is True, f"TEP status was mutated: {row}"
    assert row["tep_details"] == TEP_MARKER, f"TEP details were mutated: {row}"
    assert row["dnacpr_decision"] is True, f"DNACPR status was mutated: {row}"
    assert row["dnacpr_details"] == DNACPR_MARKER, f"DNACPR details were mutated: {row}"


def main():
    patient_id = None
    try:
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # Establish the origin, but NEVER write a session — stay logged out.
            page.goto(BASE_URL, wait_until="domcontentloaded")
            token = page.evaluate(
                "() => window.localStorage.getItem('sb-%s-auth-token')" % PROJECT_REF
            )
            assert not token, "unexpected pre-existing session; test must run logged out"

            # ---- A. Create UI (board) is sealed ----
            assert_route_sealed(
                page,
                f"{BASE_URL}/patients",
                "board/create",
                forbidden_controls=[
                    ("button", "Add patient"),
                    ("button", "New patient"),
                ],
            )
            page.screenshot(path=str(SCREENSHOTS / "logged_out_create_blocked.png"))

            # ---- A. Edit UI + escalation/CPR toggles (detail) are sealed ----
            assert_route_sealed(
                page,
                f"{BASE_URL}/patients/{patient_id}",
                "detail/edit",
                forbidden_controls=[
                    ("button", "Edit"),
                    ("tab", "Overview"),
                    ("tab", "Status"),
                ],
            )
            page.screenshot(path=str(SCREENSHOTS / "logged_out_edit_escalation_blocked.png"))

            browser.close()

        # ---- B. Data layer refuses anonymous create + escalation/CPR edit ----
        assert_data_layer_blocked(patient_id)

        print(
            "PASS: logged out, create/edit patient and escalation/CPR routes redirect "
            "to /auth with no markers in the DOM, and the data layer rejects anonymous "
            "create/edit of escalation (TEP) and CPR (DNACPR) status"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id)


if __name__ == "__main__":
    sys.exit(main())
