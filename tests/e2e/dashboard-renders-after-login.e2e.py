"""
End-to-end test: after login, the main dashboard (/patients) renders fully with
NO hydration regeneration and NO missing data.

"Hydration regeneration" is the failure the app previously suffered: the SSR
tree mismatched the client bundle, so React discarded the server HTML and
regenerated the whole tree (a visible flash / loop). React reports this via
console errors ("hydrat...", minified #418/#423/#425) and, in the worst case,
`document.documentElement` is replaced after load. This test asserts none of
that happens while the dashboard renders.

  AFTER LOGIN
    1. /patients loads without redirecting to /auth.
    2. No hydration / minified-React console errors or page errors are emitted
       during load and settle.
    3. The <html> element is NOT replaced after initial paint (no full-tree
       regeneration) — we tag it before load and confirm the tag survives.
    4. The dashboard chrome renders (the "Patients" nav / heading is present)
       and the seeded patient's data is actually visible in the DOM (name marker
       + hospital number) — i.e. no missing data.

A throwaway clinician user + one fully-populated patient (with an alphanumeric
name marker) are created and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/dashboard-renders-after-login.e2e.py
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
NAME_MARKER = f"Dashwood{STAMP}"
HOSPITAL_NUMBER = f"HN{STAMP}"
PASSWORD = "Test-Passw0rd-123!"

# Substrings that mean React tore down and rebuilt the SSR tree, or a hydration
# mismatch occurred. #418/#423/#425 are the minified prod codes for hydration
# text/tree mismatches and root recreation.
HYDRATION_SIGNS = [
    "hydrat",
    "did not match",
    "server html",
    "minified react error #418",
    "minified react error #423",
    "minified react error #425",
    "error #418",
    "error #423",
    "error #425",
]


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-dash-{STAMP}@example.com"
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
            "full_name": NAME_MARKER,
            "age": 51,
            "hospital_number": HOSPITAL_NUMBER,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "3",
            "status": "admitted",
            "current_admission": f"Admission {NAME_MARKER}",
            "current_management": f"Note {NAME_MARKER}",
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


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # Collect anything React might emit about hydration.
            problems = []
            page.on(
                "console",
                lambda m: problems.append(m.text)
                if m.type in ("error", "warning")
                else None,
            )
            page.on("pageerror", lambda e: problems.append(str(e)))

            # Seed the session before hitting the protected route.
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 1. Dashboard loads and does not bounce to /auth ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            # Tag the current <html> node so we can detect a full-tree rebuild.
            page.evaluate("() => { document.documentElement.dataset.e2eTag = '1'; }")

            page.wait_for_load_state("networkidle")
            # Give React a beat to flush any late hydration warning.
            page.wait_for_timeout(1500)
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            # ---- 3. <html> not replaced (no full regeneration) ----
            still_tagged = page.evaluate(
                "() => document.documentElement.dataset.e2eTag === '1'"
            )
            assert still_tagged, (
                "the <html> element was replaced after load — the app regenerated "
                "the whole tree (hydration mismatch)"
            )

            # ---- 4. Dashboard chrome + seeded data are visible ----
            expect(
                page.get_by_role("link", name="ICU Handover")
            ).to_be_visible(timeout=20000)
            expect(
                page.get_by_text(NAME_MARKER, exact=False).first
            ).to_be_visible(timeout=20000)

            dom_text = page.evaluate("() => document.body.innerText")
            assert NAME_MARKER in dom_text, "seeded patient name missing from dashboard"
            assert HOSPITAL_NUMBER in dom_text, (
                "seeded patient hospital number missing from dashboard"
            )

            page.screenshot(path=str(SCREENSHOTS / "dashboard_after_login.png"))

            # ---- 2. No hydration / minified-React errors during the whole load ----
            hydration_hits = [
                p for p in problems
                if any(sign in p.lower() for sign in HYDRATION_SIGNS)
            ]
            assert not hydration_hits, (
                "hydration / regeneration errors were emitted while rendering the "
                f"dashboard: {hydration_hits}"
            )

            browser.close()

        print(
            "PASS: dashboard renders fully after login with no hydration "
            "regeneration and no missing data"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
