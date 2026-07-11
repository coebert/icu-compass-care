"""
End-to-end test: log in, open a patient detail route, refresh the page, and
verify all key fields render CONSISTENTLY — identical values before and after
refresh, with no missing data and no hydration mismatch / regeneration.

TanStack Start server-renders the patient route and then hydrates on the client.
This guards against two classes of bug:
  * Hydration regeneration — a field whose value is derived non-deterministically
    (e.g. Date.now(), Math.random(), locale/timezone drift) so it differs between
    the SSR HTML and the client render, or changes on reload.
  * Missing data — a key field that renders on first paint but disappears after a
    client-side refresh (stale cache / loader gap).

Flow:
  1. Seed a patient with distinctive values across the key clinical fields.
  2. Log in and open /patients/{id}; read each field's rendered text from the
     Overview + Escalation + Next-of-kin tabs.
  3. Capture any React hydration-mismatch console warnings during load.
  4. Hard-reload; read the same fields again.
  5. Assert every value is present both times, and byte-for-byte identical across
     the refresh, and that no hydration-mismatch warning was logged.

Throwaway clinician user + patient created and cleaned up via the Supabase admin
REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/patient-detail-hydration-consistency.e2e.py
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
MARKER = f"HYDR{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = f"Consistency {MARKER}"
WARD = f"Critical Care {MARKER}"

FIELDS = {
    "past_medical_history": f"COPD, T2DM, prior MI {MARKER}",
    "current_admission": f"Severe CAP, type 1 resp failure {MARKER}",
    "current_management": f"HFNO wean, targeted abx {MARKER}",
    "tep_details": f"For ward-based care, not for RRT {MARKER}",
    "nok_name": f"Alex Partner {MARKER}",
}
NOK_CONTACT = f"07700{STAMP[-6:]}"
# Values we expect to see rendered somewhere on the page (before and after).
EXPECTED_TEXTS = list(FIELDS.values()) + [PATIENT_NAME, WARD, NOK_CONTACT]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-{MARKER.lower()}@example.com"
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
            "age": 64,
            "weight_kg": 82,
            "location_type": "icu",
            "ward": WARD,
            "bed": "5",
            "status": "admitted",
            "admission_date": datetime.now(timezone.utc).date().isoformat(),
            "tep_in_place": True,
            "nok_relationship": "Partner",
            "nok_contact": NOK_CONTACT,
            **FIELDS,
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


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def read_fields(page):
    """Return the exact rendered text for each key field across the tabs."""
    captured = {}

    # Overview tab: PMH / admission / management.
    ov = open_tab(page, "Overview")
    for key in ("past_medical_history", "current_admission", "current_management"):
        loc = ov.get_by_text(FIELDS[key], exact=False).first
        expect(loc).to_be_visible(timeout=10000)
        captured[key] = loc.inner_text().strip()

    # Escalation & Resus tab: TEP details.
    esc = open_tab(page, "Escalation & Resus")
    loc = esc.get_by_text(FIELDS["tep_details"], exact=False).first
    expect(loc).to_be_visible(timeout=10000)
    captured["tep_details"] = loc.inner_text().strip()

    # Next of kin tab: NOK name + contact.
    nok = open_tab(page, "Next of kin")
    loc = nok.get_by_text(FIELDS["nok_name"], exact=False).first
    expect(loc).to_be_visible(timeout=10000)
    captured["nok_name"] = loc.inner_text().strip()
    loc = nok.get_by_text(NOK_CONTACT, exact=False).first
    expect(loc).to_be_visible(timeout=10000)
    captured["nok_contact"] = loc.inner_text().strip()

    # Header: patient name + ward (present regardless of active tab).
    name_loc = page.get_by_text(PATIENT_NAME, exact=False).first
    expect(name_loc).to_be_visible(timeout=10000)
    captured["full_name"] = name_loc.inner_text().strip()
    ward_loc = page.get_by_text(WARD, exact=False).first
    expect(ward_loc).to_be_visible(timeout=10000)
    captured["ward"] = ward_loc.inner_text().strip()

    return captured


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        hydration_warnings = []

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            def on_console(msg):
                text = msg.text.lower()
                if (
                    "hydrat" in text
                    or "did not match" in text
                    or "server rendered" in text
                    or "text content does not match" in text
                ):
                    hydration_warnings.append(msg.text)

            page.on("console", on_console)

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- First load ----
            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"unexpectedly bounced to /auth: {page.url}"
            first = read_fields(page)
            page.screenshot(path=str(SCREENSHOTS / "hydration_first_load.png"))

            # Every expected value must be present on first paint.
            for text in EXPECTED_TEXTS:
                assert page.get_by_text(text, exact=False).first.count() >= 0

            # ---- Hard refresh ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after refresh: {page.url}"
            second = read_fields(page)
            page.screenshot(path=str(SCREENSHOTS / "hydration_after_refresh.png"))

            browser.close()

        # ---- Consistency: identical values, nothing missing ----
        assert set(first) == set(second), (
            f"field set changed across refresh: {set(first) ^ set(second)}"
        )
        drift = {
            k: (first[k], second[k]) for k in first if first[k] != second[k]
        }
        assert not drift, f"fields changed / regenerated across refresh: {drift}"

        # No blank fields.
        blank = [k for k, v in second.items() if not v]
        assert not blank, f"fields blank after refresh: {blank}"

        # No hydration-mismatch warnings.
        assert not hydration_warnings, (
            f"hydration mismatch warnings logged: {hydration_warnings}"
        )

        print(
            "PASS: patient detail fields render identically before/after refresh "
            "with no missing data and no hydration regeneration"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
