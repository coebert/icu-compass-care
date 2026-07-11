"""
End-to-end test SUITE (UI + Data API, all roles): the treatment escalation
plan ("escalation plan") fields behave correctly for every user role.

The escalation plan is stored on `patients` as:
  - tep_in_place (boolean)   -- "Treatment escalation plan (TEP) in place"
  - tep_details  (text)      -- "TEP details" (ceiling of care / escalation)

Clinical access is granted by private.has_clinical_access(auth.uid()), true for
the 'admin' and 'clinician' roles and false for a user with no user_roles row.
Every command on `patients` is gated behind it, so:

  clinical/admin => can READ the escalation plan and EDIT it (edit persists).
  non-clinical   => cannot READ (record is gated, details never rendered, Data
                    API returns an empty row) and cannot EDIT (no Edit button;
                    a direct Data API PATCH is a no-op / rejected).

Role matrix:
  - "admin"      (admin role)      => can read + edit -> persists
  - "clinician"  (clinician role)  => can read + edit -> persists
  - "none"       (no role)         => cannot read or edit -> unchanged

Per role the scenario is:
  1. Seed a FRESH patient with NO escalation plan (admin API).
  2. Data API read as the role: clinical sees the seeded baseline; non-clinical
     gets an empty row (fields inaccessible).
  3. UI: restore session, open /patients/<id>.
     - clinical: Edit -> toggle TEP on + enter details -> Save; assert persist.
     - non-clinical: assert access-required gate + no Edit button; then attempt a
       direct Data API PATCH and assert it does NOT persist.

Each role uses its own patient so cases are independent. All fixtures are created
and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/escalation-plan-role-based-read-edit.e2e.py
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

STAMP = str(int(time.time()))
SUFFIX = STAMP[-6:]
PASSWORD = "Test-Passw0rd-123!"

# (label, db_role_or_None, can_access)
ROLE_MATRIX = [
    ("admin", "admin", True),
    ("clinician", "clinician", True),
    ("none", None, False),
]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def user_headers(token):
    return {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def create_user(label, role):
    email = f"e2e-tep-role-{label}-{STAMP}@example.com"
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


def create_patient(label):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": f"T.{label[:1].upper()}.{SUFFIX}",
            "age": 69,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "7",
            "status": "admitted",
            # Deliberately NO escalation plan — set via the UI by clinical roles.
            "tep_in_place": False,
            "tep_details": None,
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


def read_tep_admin(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=tep_in_place,tep_details",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def restore_session(page, session):
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [STORAGE_KEY, json.dumps(session)],
    )


def clinical_edit(page, patient_id, patient_name, details):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    assert "/auth" not in page.url, f"clinical redirected to /auth: {page.url}"
    expect(page.get_by_text(patient_name, exact=False).first).to_be_visible(
        timeout=15000
    )

    page.get_by_role("button", name="Edit").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=10000)

    tep_row = dialog.locator(
        "div.flex.items-center.justify-between:"
        "has(p:text-is('Treatment escalation plan (TEP) in place'))"
    )
    tep_switch = tep_row.get_by_role("switch")
    expect(tep_switch).to_be_visible(timeout=10000)
    if tep_switch.get_attribute("aria-checked") != "true":
        tep_switch.click()

    tep_details = dialog.locator(
        "div.space-y-1\\.5:has(> label:text-is('TEP details')) textarea"
    )
    expect(tep_details).to_be_visible(timeout=10000)
    tep_details.fill(details)

    dialog.get_by_role("button", name="Save changes").click()
    expect(dialog).to_be_hidden(timeout=15000)


def nonclinical_gate(page, patient_id):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    assert "/auth" not in page.url, f"non-clinical redirected to /auth: {page.url}"
    expect(page.get_by_text("Clinical access required", exact=False)).to_be_visible(
        timeout=15000
    )
    page.wait_for_timeout(800)
    assert page.get_by_role("button", name="Edit").count() == 0, (
        "non-clinical role must not see an Edit button"
    )
    return page.inner_text("body")


def cleanup(patient_ids, user_ids):
    for pid in patient_ids:
        if pid:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
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


def main():
    patient_ids = []
    user_ids = []
    failures = []
    try:
        cases = []
        for label, role, can_access in ROLE_MATRIX:
            uid, email = create_user(label, role)
            user_ids.append(uid)
            pid = create_patient(label)
            patient_ids.append(pid)
            session = sign_in(email)
            cases.append((label, can_access, pid, session, f"tep-{label}-{SUFFIX}"))

            base = read_tep_admin(pid)
            assert base["tep_in_place"] in (False, None), f"[{label}] baseline TEP set"

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for label, can_access, pid, session, details in cases:
                token = session["access_token"]
                patient_name = f"T.{label[:1].upper()}.{SUFFIX}"
                try:
                    # ---- Data API read expectation ----
                    api = requests.get(
                        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}"
                        "&select=id,tep_in_place,tep_details",
                        headers=user_headers(token),
                        timeout=30,
                    )
                    if can_access:
                        assert api.status_code == 200 and len(api.json()) == 1, (
                            f"[{label}] clinical Data API read failed: {api.text}"
                        )
                    else:
                        assert api.status_code in (200, 401, 403), (
                            f"[{label}] unexpected read status: {api.status_code}"
                        )
                        if api.status_code == 200:
                            assert api.json() == [], (
                                f"[{label}] non-clinical read disclosed TEP: {api.text}"
                            )

                    # ---- UI + edit expectation ----
                    ctx = browser.new_context(viewport={"width": 1280, "height": 1800})
                    page = ctx.new_page()
                    restore_session(page, session)

                    if can_access:
                        clinical_edit(page, pid, patient_name, details)
                        page.screenshot(
                            path=str(SCREENSHOTS / f"tep_role_{label}_{SUFFIX}.png")
                        )
                        final = read_tep_admin(pid)
                        assert final["tep_in_place"] is True, (
                            f"[{label}] TEP edit did not persist: {final}"
                        )
                        assert final["tep_details"] == details, (
                            f"[{label}] TEP details did not persist: {final}"
                        )
                        print(f"  [{label}] OK (read + edit persisted)")
                    else:
                        body = nonclinical_gate(page, pid)
                        page.screenshot(
                            path=str(SCREENSHOTS / f"tep_role_{label}_{SUFFIX}.png")
                        )
                        # Attempt a direct Data API tamper — must not persist.
                        requests.patch(
                            f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
                            headers={
                                **user_headers(token),
                                "Prefer": "return=representation",
                            },
                            json={"tep_in_place": True, "tep_details": details},
                            timeout=30,
                        )
                        final = read_tep_admin(pid)
                        assert final["tep_in_place"] in (False, None), (
                            f"[{label}] TEP changed despite no access: {final}"
                        )
                        assert not final["tep_details"], (
                            f"[{label}] TEP details written despite no access: {final}"
                        )
                        assert details not in body, (
                            f"[{label}] TEP details leaked into gated view"
                        )
                        print(f"  [{label}] OK (no read, no edit, unchanged)")
                    ctx.close()
                except Exception as case_exc:  # noqa: BLE001
                    failures.append(f"[{label}] {case_exc}")
                    print(f"  [{label}] FAILED: {case_exc}", file=sys.stderr)
            browser.close()

        if failures:
            print(f"FAIL: {len(failures)} role case(s) failed", file=sys.stderr)
            return 1
        print("PASS: escalation plan read/edit behaves as expected across all roles")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_ids, user_ids)


if __name__ == "__main__":
    sys.exit(main())
