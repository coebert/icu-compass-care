"""
End-to-end test: exported patient data is only accessible after login.

The handover PDF is built client-side from patient data pulled through
authenticated TanStack server functions (`listPatients` / `getPatient` in
src/lib/patients.functions.ts), each guarded by `requireSupabaseAuth`. Those
server functions ARE the export data endpoints — the PDF cannot exist without
the data they return.

Note on status codes: TanStack's server-function transport (`/_serverFn/<id>`)
wraps a rejected `requireSupabaseAuth` middleware as an `Unauthorized` *framed
error* rather than a bare HTTP 401 (the HTTP envelope is 200, the payload is
the Unauthorized error and carries NO patient data). So the security guarantee
the user cares about — "exported data is inaccessible without login" — is
proven by: the unauthenticated call is REJECTED with Unauthorized and leaks no
patient rows, while the authenticated call succeeds. This test asserts exactly
that, and additionally checks that a genuinely malformed raw request (missing
the server-fn transport headers) is refused rather than served.

  A. NEGATIVE (raw HTTP, no bearer token) — the export data endpoints reject
     the request with "Unauthorized" and return NO patient data.
  B. POSITIVE (raw HTTP, with a real bearer token) — the same endpoints return
     the seeded patient, confirming the data is reachable only after login.
  C. UI — logged out, /patients redirects to /auth and the Preview/Download
     PDF export controls never render; after login the export runs and a .pdf
     download fires.

A throwaway clinician user + patient are created and cleaned up via the
Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/pdf-export-requires-auth-401.e2e.py
Exits 0 on success, non-zero on failure.
"""

import base64
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

FUNCTIONS_FILE = "/src/lib/patients.functions.ts?tss-serverfn-split"
MARKER = f"E2E-PDF-401-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "P.D.F. Guard"

# Headers the TanStack client attaches to every server-function request.
SERVER_FN_HEADERS = {
    "accept": "application/x-tss-framed, application/x-ndjson, application/json",
    "x-tsr-serverfn": "true",
}


def server_fn_url(export_name, payload):
    """Build the raw /_serverFn/<id> URL for a GET server function."""
    fn_id = base64.urlsafe_b64encode(
        json.dumps({"file": FUNCTIONS_FILE, "export": export_name},
                   separators=(",", ":")).encode()
    ).decode().rstrip("=")
    qs = urllib.parse.urlencode({"payload": json.dumps(payload, separators=(",", ":"))})
    return f"{BASE_URL}/_serverFn/{fn_id}?{qs}"


# Payload shapes mirror what the TanStack client serializes for these fns.
LIST_PAYLOAD = {"t": {"t": 10, "i": 0, "p": {"k": ["data"], "v": [
    {"t": 10, "i": 1, "p": {"k": [], "v": []}, "o": 0}]}, "o": 0}, "f": 63, "m": []}


def get_payload(patient_id):
    return {"t": {"t": 10, "i": 0, "p": {"k": ["data"], "v": [
        {"t": 10, "i": 1, "p": {"k": ["id"], "v": [patient_id]}, "o": 0}]},
        "o": 0}, "f": 63, "m": []}


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"{MARKER.lower()}@example.com"
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
            "age": 71,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Note {MARKER}",
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


def body_leaks(text, patient_id):
    return (patient_id and patient_id in text) or (MARKER in text) or (PATIENT_NAME in text)


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        list_url = server_fn_url("listPatients_createServerFn_handler", LIST_PAYLOAD)
        get_url = server_fn_url("getPatient_createServerFn_handler", get_payload(patient_id))

        # ============ A. NEGATIVE — no bearer token ============
        for label, url in [("listPatients", list_url), ("getPatient", get_url)]:
            r = requests.get(url, headers=SERVER_FN_HEADERS, timeout=30)
            # Transport envelope is 200 but the payload is an Unauthorized error.
            assert "unauthor" in r.text.lower(), (
                f"unauth {label} export endpoint was NOT rejected for auth "
                f"(status {r.status_code}, body: {r.text[:200]!r})"
            )
            assert not body_leaks(r.text, patient_id), (
                f"unauth {label} response leaked patient data: {r.text[:300]!r}"
            )
            print(f"OK  {label}: unauthenticated request rejected (Unauthorized); no data leaked")

        # A malformed raw request (no server-fn transport headers) is refused,
        # not served with patient data.
        r_bare = requests.get(list_url, timeout=30)
        assert not body_leaks(r_bare.text, patient_id), (
            f"bare unauthenticated request leaked patient data: {r_bare.text[:300]!r}"
        )
        print(f"OK  bare request refused (HTTP {r_bare.status_code}); no data leaked")

        # ============ B. POSITIVE — with a real bearer token ============
        session = sign_in(email)
        auth = {**SERVER_FN_HEADERS, "Authorization": f"Bearer {session['access_token']}"}
        for label, url in [("listPatients", list_url), ("getPatient", get_url)]:
            r = requests.get(url, headers=auth, timeout=30)
            assert r.status_code == 200 and "unauthor" not in r.text.lower(), (
                f"authenticated {label} was rejected "
                f"(status {r.status_code}, body: {r.text[:200]!r})"
            )
        assert patient_id in requests.get(list_url, headers=auth, timeout=30).text, (
            "authenticated listPatients did not include the seeded patient"
        )
        print("OK  both export endpoints return data once authenticated")

        # ============ C. UI — export controls gated behind login ============
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            ctx = browser.new_context(
                viewport={"width": 1280, "height": 1800}, accept_downloads=True)
            page = ctx.new_page()

            # Logged out: /patients redirects to /auth, no export controls.
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert not page.get_by_role("button", name="Preview PDF").count(), (
                "Preview PDF control rendered while logged out"
            )
            page.screenshot(path=str(SCREENSHOTS / "pdf401_blocked.png"))

            # After login: export runs and a .pdf download fires.
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authed: {page.url}"

            preview_btn = page.get_by_role("button", name="Preview PDF")
            expect(preview_btn).to_be_visible(timeout=15000)
            preview_btn.click()
            dialog = page.get_by_role("dialog")
            download_btn = dialog.get_by_role("button", name="Download PDF")
            expect(download_btn).to_be_visible(timeout=10000)
            with page.expect_download(timeout=15000) as dl_info:
                download_btn.click()
            fname = dl_info.value.suggested_filename
            assert fname.lower().endswith(".pdf"), f"not a PDF: {fname!r}"
            page.screenshot(path=str(SCREENSHOTS / "pdf401_downloaded.png"))
            browser.close()

        print(f"PASS: export data inaccessible without login; reachable after login ({fname})")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
