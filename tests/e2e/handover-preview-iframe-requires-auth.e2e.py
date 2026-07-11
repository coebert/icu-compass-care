"""
End-to-end test: the handover PREVIEW iframe never renders patient data for
unauthenticated users, and only becomes visible after login.

The preview page (/patients/handover-preview) embeds the generated handover PDF
in an <iframe title="Handover PDF preview"> via a same-origin blob: URL. Because
the whole route lives behind the _authenticated gate, a logged-out visitor is
redirected to /auth before any PDF is built — so no iframe, no blob, and no
patient-identifiable text ever reach the page. After login the iframe appears
and its embedded PDF actually contains the seeded patient's data.

  LOGGED OUT
    1. Deep-link to /patients/handover-preview redirects to /auth.
    2. No <iframe title="Handover PDF preview"> exists, and no iframe points at
       a blob:/data: PDF source.
    3. The seeded patient's identifiable marker appears NOWHERE in the rendered
       DOM.

  AFTER LOGIN
    4. The preview iframe becomes visible with a blob: source.
    5. Fetching that blob yields a real PDF (%PDF-) whose contents include the
       seeded patient's marker — proving the preview only renders patient data
       once authenticated.

A throwaway clinician user + a fully-populated patient (with an alphanumeric
name marker) are created and cleaned up via the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-preview-iframe-requires-auth.e2e.py
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

# Alphanumeric marker so it survives PDF text encoding intact and is easy to
# search for both in the DOM and in the raw PDF bytes.
STAMP = str(int(time.time()))
NAME_MARKER = f"Zephyrine{STAMP}"
PASSWORD = "Test-Passw0rd-123!"
IFRAME_SELECTOR = "iframe[title='Handover PDF preview']"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user():
    email = f"e2e-iframe-{STAMP}@example.com"
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
    # Complete record (all critical fields) with an alphanumeric name marker so
    # it definitely renders in the preview PDF's name column.
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": NAME_MARKER,
            "age": 47,
            "hospital_number": f"HN{STAMP}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "2",
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


# Fetch the iframe's blob: PDF from inside the page (same-origin) and return the
# body as a latin1 string so the test can scan the raw PDF text for the marker.
FETCH_IFRAME_PDF = """
async (selector) => {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "iframe not found" };
  const src = el.getAttribute("src") || "";
  const url = src.split("#")[0];
  if (!url.startsWith("blob:") && !url.startsWith("data:")) {
    return { ok: false, error: "iframe src is not a blob/data url: " + url };
  }
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return { ok: true, src: url, body: s };
}
"""


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # ============ LOGGED OUT ============
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. Deep-link redirects to /auth ----
            page.goto(
                f"{BASE_URL}/patients/handover-preview",
                wait_until="domcontentloaded",
            )
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth, got {page.url}"
            )

            # ---- 2. No preview iframe / no PDF blob source is present ----
            assert page.locator(IFRAME_SELECTOR).count() == 0, (
                "preview iframe rendered while logged out"
            )
            pdf_iframes = page.evaluate(
                """() => Array.from(document.querySelectorAll("iframe"))
                    .map(f => f.getAttribute("src") || "")
                    .filter(s => s.startsWith("blob:") || s.startsWith("data:"))
                    .length"""
            )
            assert pdf_iframes == 0, (
                f"a blob/data PDF iframe is present while logged out ({pdf_iframes})"
            )

            # ---- 3. No patient marker anywhere in the DOM ----
            dom_text = page.evaluate(
                "() => document.documentElement.innerHTML"
            )
            assert NAME_MARKER not in dom_text, (
                "patient marker leaked into the DOM while logged out"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_iframe_blocked.png")
            )
            print("OK  logged out: redirected, no preview iframe, no patient data")

            # ============ AFTER AUTHENTICATION ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- 4. Preview iframe becomes visible with a blob source ----
            page.goto(
                f"{BASE_URL}/patients/handover-preview",
                wait_until="domcontentloaded",
            )
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )
            iframe = page.locator(IFRAME_SELECTOR)
            expect(iframe).to_be_visible(timeout=20000)
            src = iframe.get_attribute("src") or ""
            assert src.startswith("blob:"), (
                f"preview iframe src is not a blob URL after login: {src!r}"
            )

            # ---- 5. The embedded PDF is real and contains the patient data ----
            fetched = page.evaluate(FETCH_IFRAME_PDF, IFRAME_SELECTOR)
            assert fetched["ok"], f"could not read iframe PDF: {fetched.get('error')}"
            body = fetched["body"]
            assert body.startswith("%PDF-"), (
                "iframe content is not a valid PDF after login"
            )
            # Strip whitespace/parens the PDF text operators introduce, then look
            # for the alphanumeric marker to confirm patient data is present.
            flat = "".join(ch for ch in body if ch.isalnum())
            assert NAME_MARKER in flat, (
                "authenticated preview PDF does not contain the patient marker "
                "— preview is not rendering the seeded patient's data"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_iframe_visible.png")
            )
            print("OK  logged in: preview iframe visible and PDF contains patient data")

            browser.close()

        print(
            "PASS: preview iframe hides all patient data when logged out and only "
            "renders it after login"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
