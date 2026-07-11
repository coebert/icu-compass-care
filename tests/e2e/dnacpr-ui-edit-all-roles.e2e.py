"""
End-to-end test SUITE (UI, all roles): runs the SAME DNACPR edit scenario
against a patient for every user role and verifies the expected outcome —
persistence for clinical roles, rejection (gated, no Edit, values unchanged)
for non-clinical.

DNACPR is stored on `patients` as:
  - dnacpr_decision (boolean)
  - dnacpr_details  (text)

Clinical access is granted by private.has_clinical_access(auth.uid()), which is
true for the 'admin' and 'clinician' roles and false for a user with no
user_roles row. The patient detail route gates the whole record behind clinical
access: non-clinical users see <ClinicalAccessRequired> and get no Edit button.

Role matrix under test:
  - "admin"      (admin role)      => CAN edit  -> value persists
  - "clinician"  (clinician role)  => CAN edit  -> value persists
  - "none"       (no role)         => CANNOT edit -> gated, value unchanged

Per role the scenario is:
  1. Seed a FRESH patient with NO DNACPR (admin API).
  2. Restore that role's session and navigate to /patients/<id>.
  3a. Clinical role: open Edit -> toggle DNACPR on + enter details -> Save.
      Assert (admin read) the value persisted.
  3b. Non-clinical role: assert the access-required gate and no Edit button.
      Assert (admin read) DNACPR is still unset — nothing persisted.

Each role uses its own patient so the cases are fully independent. All fixtures
are created and cleaned up via the Supabase admin REST API.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
Run:  python3 tests/e2e/dnacpr-ui-edit-all-roles.e2e.py
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

# (label, db_role_or_None, can_edit)
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


def create_user(label, role):
    email = f"e2e-dnacpr-allroles-{label}-{STAMP}@example.com"
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
            "full_name": f"R.{label[:1].upper()}.{SUFFIX}",
            "age": 70,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "6",
            "status": "admitted",
            # Deliberately NO DNACPR — set via the UI by clinical roles.
            "dnacpr_decision": False,
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


def read_dnacpr(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=dnacpr_decision,dnacpr_details",
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


def run_clinical_case(page, patient_id, patient_name, details):
    """Clinical role: edit DNACPR via the UI and assert it persists."""
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    assert "/auth" not in page.url, f"clinical role redirected to /auth: {page.url}"
    expect(page.get_by_text(patient_name, exact=False).first).to_be_visible(
        timeout=15000
    )

    page.get_by_role("button", name="Edit").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=10000)

    dnacpr_row = dialog.locator(
        "div.flex.items-center.justify-between:"
        "has(p:text-is('DNACPR — decision not to attempt CPR'))"
    )
    dnacpr_switch = dnacpr_row.get_by_role("switch")
    expect(dnacpr_switch).to_be_visible(timeout=10000)
    if dnacpr_switch.get_attribute("aria-checked") != "true":
        dnacpr_switch.click()

    dnacpr_details = dialog.locator(
        "div.space-y-1\\.5:has(> label:text-is('DNACPR details')) input"
    )
    expect(dnacpr_details).to_be_visible(timeout=10000)
    dnacpr_details.fill(details)

    dialog.get_by_role("button", name="Save changes").click()
    expect(dialog).to_be_hidden(timeout=15000)


def run_nonclinical_case(page, patient_id):
    """Non-clinical role: assert the record is gated and not editable."""
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    assert "/auth" not in page.url, f"non-clinical role redirected to /auth: {page.url}"
    expect(page.get_by_text("Clinical access required", exact=False)).to_be_visible(
        timeout=15000
    )
    assert page.get_by_role("button", name="Edit").count() == 0, (
        "non-clinical role must not see an Edit button"
    )


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
        # Provision one user + one patient per role.
        cases = []
        for label, role, can_edit in ROLE_MATRIX:
            uid, email = create_user(label, role)
            user_ids.append(uid)
            pid = create_patient(label)
            patient_ids.append(pid)
            session = sign_in(email)
            details = f"dnacpr-{label}-{SUFFIX}"
            cases.append((label, can_edit, pid, session, details))

            base = read_dnacpr(pid)
            assert base["dnacpr_decision"] in (False, None), (
                f"[{label}] baseline DNACPR already set: {base}"
            )

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for label, can_edit, pid, session, details in cases:
                ctx = browser.new_context(viewport={"width": 1280, "height": 1800})
                page = ctx.new_page()
                restore_session(page, session)
                patient_name = f"R.{label[:1].upper()}.{SUFFIX}"
                try:
                    if can_edit:
                        run_clinical_case(page, pid, patient_name, details)
                        final = read_dnacpr(pid)
                        assert final["dnacpr_decision"] is True, (
                            f"[{label}] edit did not persist: {final}"
                        )
                        assert final["dnacpr_details"] == details, (
                            f"[{label}] details did not persist: {final}"
                        )
                    else:
                        run_nonclinical_case(page, pid)
                        final = read_dnacpr(pid)
                        assert final["dnacpr_decision"] in (False, None), (
                            f"[{label}] DNACPR changed despite no access: {final}"
                        )
                        assert not final["dnacpr_details"], (
                            f"[{label}] DNACPR details written despite no access: {final}"
                        )
                    page.screenshot(
                        path=str(SCREENSHOTS / f"dnacpr_allroles_{label}_{SUFFIX}.png")
                    )
                    print(
                        f"  [{label}] OK "
                        f"({'edit persisted' if can_edit else 'gated, unchanged'})"
                    )
                except Exception as case_exc:  # noqa: BLE001
                    failures.append(f"[{label}] {case_exc}")
                    print(f"  [{label}] FAILED: {case_exc}", file=sys.stderr)
                finally:
                    ctx.close()
            browser.close()

        if failures:
            print(f"FAIL: {len(failures)} role case(s) failed", file=sys.stderr)
            return 1
        print("PASS: DNACPR UI edit scenario behaves as expected across all roles")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_ids, user_ids)


if __name__ == "__main__":
    sys.exit(main())
