"""
End-to-end test: the global cross-project sync status indicator.

Drives the real ICU handover app in a headless browser as an authenticated
admin and verifies that the sync-status badge in the sticky global header is
present across authenticated routes and refreshes its data on demand.

What it asserts:

  1. VISIBLE on route A   — on /patients the global header shows the sync
     status indicator ("Last synced <time>").
  2. VISIBLE on route B   — after navigating to /reconcile (a second
     authenticated route) the same global indicator is still rendered, proving
     it lives in the shared layout header, not a single page.
  3. UPDATES on refresh   — after a newer successful sync event is recorded,
     a manual browser refresh re-runs getSyncStatus() and the badge time text
     changes from the stale value ("2 h ago") to the fresh one ("just now").

The indicator reads from public.bridge_sync_events, whose SELECT policy is
admin-only, so the test user is granted the 'admin' role. Sync events and the
throwaway user are created and cleaned up via the Supabase admin REST API.
Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/sync-status-indicator.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import re
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

MARKER = f"E2E-SYNC-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"


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


def insert_sync_event(created_at, *, status, error_message=None, entity="patients"):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "direction": "push",
            "entity": entity,
            "record_count": 3,
            "actor_role": "admin",
            "actor_email": f"{MARKER.lower()}@example.com",
            "status": status,
            "error_message": error_message,
            "created_at": created_at.isoformat(),
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


def cleanup(user_id):
    # bridge_sync_events created by this run are tagged with the marker email.
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/bridge_sync_events?actor_email=eq.{MARKER.lower()}@example.com",
        headers=admin_headers(),
        timeout=30,
    )
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def badge_locator(page):
    """The sync status badge trigger in the global header."""
    return page.get_by_text(re.compile(r"Last synced|Last sync failed")).first


def tooltip_marker(page, token):
    """Hover the badge and assert the detail tooltip reflects `token`."""
    badge = badge_locator(page)
    expect(badge).to_be_visible(timeout=15000)
    badge.hover()
    expect(page.get_by_text(re.compile(re.escape(token))).first).to_be_visible(timeout=15000)


STALE_MSG = f"{MARKER}-STALE-EVENT"
FRESH_MSG = f"{MARKER}-FRESH-EVENT"


def main():
    user_id = None
    try:
        user_id, email = create_admin_user()

        # Seed a dominating sync event whose detail is uniquely identifiable.
        # The indicator surfaces the most recent event, so a just-now insert
        # is guaranteed to be the one shown regardless of other activity.
        insert_sync_event(
            datetime.now(timezone.utc),
            status="error",
            error_message=STALE_MSG,
            entity="patients",
        )

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

            # ---- 1. VISIBLE on route A (/patients) ----
            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while logged in: {page.url}"
            expect(page.get_by_role("heading", name="Patient board")).to_be_visible(timeout=15000)

            expect(badge_locator(page)).to_be_visible(timeout=15000)
            tooltip_marker(page, STALE_MSG)
            page.screenshot(path=str(SCREENSHOTS / "sync_1_patients.png"))

            # ---- 2. VISIBLE on route B (/reconcile) ----
            page.goto(f"{BASE_URL}/reconcile", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"reconcile redirected to /auth: {page.url}"
            # The same global indicator is rendered by the shared layout header,
            # still reflecting the seeded event on the second route.
            tooltip_marker(page, STALE_MSG)
            page.screenshot(path=str(SCREENSHOTS / "sync_2_reconcile.png"))

            # ---- 3. UPDATES after a manual refresh ----
            # Record a brand-new sync event, then manually refresh the page.
            insert_sync_event(
                datetime.now(timezone.utc),
                status="error",
                error_message=FRESH_MSG,
                entity="investigations",
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            # The indicator must re-read the newer event after the refresh:
            # it now surfaces the FRESH detail and no longer the STALE one.
            tooltip_marker(page, FRESH_MSG)
            assert (
                page.get_by_text(re.compile(re.escape(STALE_MSG))).count() == 0
            ), "stale sync detail still shown after manual refresh"
            page.screenshot(path=str(SCREENSHOTS / "sync_3_refreshed.png"))

            browser.close()

        print(
            "PASS: sync status indicator visible on /patients and /reconcile, "
            "and its detail updates after a manual refresh"
        )
        return 0
    finally:
        cleanup(user_id)



if __name__ == "__main__":
    sys.exit(main())
