"""
End-to-end test: the authenticated screens render correctly at a small phone
width (360px) and a tablet width (768px), with key actions and tab switching
reachable without horizontal clipping.

Drives the real ICU handover app in a headless browser as an authenticated
admin and asserts, at 360x740 (phone) and 768x1024 (tablet), that:

  1. Patient board (/patients)
       - "Patient board" heading, search input and "Add patient" button are
         visible and fully within the viewport (no right-edge clipping).
       - "Preview PDF" key action is reachable.
  2. Patient detail (/patients/:id)
       - The tab list container fits within the viewport (no clipping of the
         scroll container itself).
       - EVERY tab (Overview, Escalation & Resus, Next of kin, Investigations,
         Microbiology, Timeline, Status, History) can be scrolled to, clicked,
         and becomes the active tab, and its panel content renders inside the
         viewport horizontally.
  3. Staff / admin (/admin)
       - "Staff accounts" heading and "New account" button reachable.

A throwaway admin user (+ one patient with an investigation) is created and
cleaned up via the Supabase admin REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/responsive-tabs-actions.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
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

MARKER = f"E2E-RESPTAB-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "R.T.A."

VIEWPORTS = [
    {"name": "phone-360", "width": 360, "height": 740, "min_tap": 40},
    {"name": "tablet-768", "width": 768, "height": 1024, "min_tap": 32},
]

TAB_NAMES = [
    "Overview",
    "Escalation & Resus",
    "Next of kin",
    "Investigations",
    "Microbiology",
    "Timeline",
    "Status",
    "History",
]

now = datetime.now(timezone.utc)


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
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
        json={"user_id": uid, "role": "admin"},
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
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Responsive tab test {MARKER}",
        },
        timeout=30,
    )
    r.raise_for_status()
    pid = r.json()[0]["id"]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/investigations",
        headers=admin_headers(),
        json={
            "patient_id": pid,
            "category": "Bloods",
            "findings": "Resp tab bloods",
            "result_at": (now - timedelta(hours=1)).isoformat(),
        },
        timeout=30,
    ).raise_for_status()
    return pid


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
            f"{SUPABASE_URL}/rest/v1/investigations?patient_id=eq.{patient_id}",
            headers=admin_headers(),
            timeout=30,
        )
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


def assert_within_viewport(locator, label, vp):
    """Visible and fully inside the viewport horizontally (no clipping)."""
    expect(locator, f"{label} should be visible on {vp['name']}").to_be_visible(timeout=15000)
    box = locator.bounding_box()
    assert box is not None, f"{label}: no bounding box on {vp['name']}"
    assert box["x"] >= -1, f"{label} starts off the left edge on {vp['name']} (x={box['x']:.0f})"
    right = box["x"] + box["width"]
    assert right <= vp["width"] + 1, (
        f"{label} overflows the right edge on {vp['name']} (right={right:.0f} > {vp['width']})"
    )


def assert_usable(locator, label, vp):
    assert_within_viewport(locator, label, vp)
    box = locator.bounding_box()
    assert box["height"] >= vp["min_tap"], (
        f"{label} too short to tap reliably on {vp['name']} "
        f"(height={box['height']:.0f} < {vp['min_tap']})"
    )


def restore_session(page, session):
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [STORAGE_KEY, json.dumps(session)],
    )


def check_patient_board(page, vp):
    page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"patient board redirected to /auth: {page.url}"
    expect(page.get_by_role("heading", name="Patient board")).to_be_visible(timeout=15000)

    search = page.get_by_placeholder("Search initials or hospital no.…")
    assert_usable(search, "Patient search input", vp)
    search.click()
    search.fill(PATIENT_NAME)
    expect(search).to_have_value(PATIENT_NAME)
    search.fill("")

    assert_usable(page.get_by_role("button", name="Add patient"), "Add patient button", vp)
    assert_usable(page.get_by_role("button", name="Preview PDF"), "Preview PDF button", vp)

    page.screenshot(path=str(SCREENSHOTS / f"board_{vp['name']}.png"))


def check_patient_detail_tabs(page, patient_id, vp):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"patient detail redirected to /auth: {page.url}"

    # The tab list container itself must fit within the viewport (its content
    # may scroll horizontally, but the container must not clip off-screen).
    tablist = page.get_by_role("tablist").first
    assert_within_viewport(tablist, "Patient detail tab list", vp)

    for name in TAB_NAMES:
        tab = page.get_by_role("tab", name=name, exact=True)
        expect(tab, f"tab '{name}' should exist on {vp['name']}").to_have_count(1, timeout=10000)
        # Scroll the tab into the horizontally-scrollable list, then it must be
        # reachable (clickable) and become the active tab.
        tab.scroll_into_view_if_needed()
        tab.click()
        expect(tab).to_have_attribute("data-state", "active", timeout=5000)

        # The active panel content must render inside the viewport horizontally.
        panel = page.get_by_role("tabpanel")
        expect(panel.first).to_be_visible(timeout=10000)
        box = panel.first.bounding_box()
        assert box is not None, f"panel for '{name}': no bounding box on {vp['name']}"
        right = box["x"] + box["width"]
        assert right <= vp["width"] + 1, (
            f"'{name}' panel overflows the right edge on {vp['name']} "
            f"(right={right:.0f} > {vp['width']})"
        )
        print(f"    tab '{name}' switch OK on {vp['name']}")

    page.screenshot(path=str(SCREENSHOTS / f"detail_tabs_{vp['name']}.png"))


def check_admin(page, vp):
    page.goto(f"{BASE_URL}/admin", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"admin redirected to /auth: {page.url}"

    expect(page.get_by_role("heading", name="Staff accounts")).to_be_visible(timeout=15000)
    assert_usable(page.get_by_role("button", name="New account"), "New account button", vp)

    page.screenshot(path=str(SCREENSHOTS / f"admin_{vp['name']}.png"))


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for vp in VIEWPORTS:
                print(f"[{vp['name']}] {vp['width']}x{vp['height']}")
                context = browser.new_context(
                    viewport={"width": vp["width"], "height": vp["height"]}
                )
                page = context.new_page()
                restore_session(page, session)

                check_patient_board(page, vp)
                check_patient_detail_tabs(page, patient_id, vp)
                check_admin(page, vp)

                context.close()
                print(f"[{vp['name']}] OK")

            browser.close()

        print("PASS: authenticated screens usable at 360px and 768px; tabs switch without clipping")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
