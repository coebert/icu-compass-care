"""
End-to-end test: capturing two handover versions for the SAME patient and
opening "Compare versions" highlights the changed Management and Escalation plan
fields in the diff.

The Compare page (/patients/compare) diffs two saved handover snapshots and, per
patient, shows only the fields that changed with a before (red) and after (green)
value. This test proves the management + escalation-plan changes surface:

  1. Seed a clinician user and two handover versions whose snapshots contain the
     SAME patient (same id, so the diff matches them as "both") but with
     DIFFERENT current_management and DIFFERENT escalation (TEP / DNACPR) values.
  2. Sign in and open /patients/compare.
  3. Pick the earlier version in the "before" selector and the later version in
     the "after" selector.
  4. Assert the patient's diff card renders, the "Management" and
     "Escalation plan (TEP / DNACPR)" field labels appear as changed fields, and
     both the old and new values for each are shown.
  5. Assert an UNCHANGED field (Current admission, identical in both snapshots)
     is NOT listed among the changed fields.

Throwaway user + two versions are created and cleaned up via the Supabase admin
REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/compare-versions-highlights-management-escalation.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
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

PATIENT_ID = str(uuid.uuid4())
PATIENT_NAME = f"CmpPatient{SUFFIX}"
ADMISSION = f"Type 1 resp failure {SUFFIX}"  # identical in both -> unchanged

# Management: changes between the two versions.
MGMT_BEFORE = f"CPAP overnight {SUFFIX}"
MGMT_AFTER = f"Intubated and ventilated {SUFFIX}"

# Escalation plan (TEP / DNACPR): changes between the two versions.
TEP_BEFORE = f"For ward-based care {SUFFIX}"
TEP_AFTER = f"For full escalation {SUFFIX}"
DNACPR_AFTER = f"Not for CPR {SUFFIX}"

VERSION_A_LABEL = f"CmpBefore AM {SUFFIX}"
VERSION_B_LABEL = f"CmpAfter PM {SUFFIX}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def base_patient():
    """Shared snapshot fields common to both versions."""
    return {
        "id": PATIENT_ID,
        "full_name": PATIENT_NAME,
        "hospital_number": f"HN{SUFFIX}",
        "age": 60,
        "location_type": "icu",
        "ward": "Critical Care",
        "bed": "6",
        "status": "admitted",
        "current_admission": ADMISSION,
    }


def snapshot_before():
    p = base_patient()
    p.update(
        {
            "current_management": MGMT_BEFORE,
            "tep_in_place": True,
            "tep_details": TEP_BEFORE,
            "dnacpr_decision": False,
            "dnacpr_details": None,
        }
    )
    return [p]


def snapshot_after():
    p = base_patient()
    p.update(
        {
            "current_management": MGMT_AFTER,
            "tep_in_place": True,
            "tep_details": TEP_AFTER,
            "dnacpr_decision": True,
            "dnacpr_details": DNACPR_AFTER,
        }
    )
    return [p]


def create_user():
    email = f"e2e-compare-{STAMP}@example.com"
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


def create_version(label, shift, snapshot):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/handover_versions",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "local_date": datetime.now(timezone.utc).date().isoformat(),
            "shift": shift,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "label": label,
            "patient_count": 1,
            "snapshot": snapshot,
            "search_text": f"{PATIENT_NAME} {label}",
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


def cleanup(version_ids, user_id):
    for vid in version_ids:
        if vid:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{vid}",
                headers=admin_headers(),
                timeout=30,
            )
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def pick_version(page, combobox_index, label):
    combo = page.get_by_role("combobox").nth(combobox_index)
    combo.click()
    page.get_by_role("option", name=label).click()
    # Selection collapses the listbox; give the query a beat to fetch.
    page.wait_for_timeout(300)


def main():
    user_id = None
    ver_a = ver_b = None
    try:
        user_id, email = create_user()
        ver_a = create_version(VERSION_A_LABEL, "am", snapshot_before())
        ver_b = create_version(VERSION_B_LABEL, "pm", snapshot_after())

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

            page.goto(f"{BASE_URL}/patients/compare", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            # Two comboboxes: [0] earlier (before), [1] later (after).
            pick_version(page, 0, VERSION_A_LABEL)
            pick_version(page, 1, VERSION_B_LABEL)

            # The patient's diff card must render.
            expect(
                page.get_by_text(PATIENT_NAME, exact=False).first
            ).to_be_visible(timeout=20000)

            page.wait_for_timeout(500)
            page.screenshot(
                path=str(SCREENSHOTS / "compare_versions_management_escalation.png")
            )

            body = page.evaluate("() => document.body.innerText")

            # ---- Changed field: Management ----
            assert "Management" in body, "Management field label missing from diff"
            assert MGMT_BEFORE in body, "old management value missing from diff"
            assert MGMT_AFTER in body, "new management value missing from diff"

            # ---- Changed field: Escalation plan (TEP / DNACPR) ----
            assert "Escalation plan" in body, (
                "Escalation plan field label missing from diff"
            )
            assert TEP_BEFORE in body, "old escalation (TEP) value missing from diff"
            assert TEP_AFTER in body, "new escalation (TEP) value missing from diff"
            assert DNACPR_AFTER in body, "new DNACPR detail missing from diff"

            # ---- Unchanged field must NOT be listed as changed ----
            # "Only show patients with changes" is on and each card lists only
            # changed fields, so the identical admission text must be absent.
            assert ADMISSION not in body, (
                "unchanged Current admission was rendered as a changed field"
            )

            browser.close()

        print(
            "PASS: Compare versions highlights the changed Management and "
            "Escalation plan fields (and omits unchanged fields)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup([ver_a, ver_b], user_id)


if __name__ == "__main__":
    sys.exit(main())
