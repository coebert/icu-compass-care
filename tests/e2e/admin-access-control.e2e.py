"""
End-to-end test: admin-only surfaces (Staff accounts + Cross-project sync
review) are inaccessible to a non-admin clinician and fully accessible to an
admin.

Both admin pages are reachable at their URLs by any signed-in user (the
_authenticated layout only checks that you're logged in), but their controls
are gated server-side: the underlying server functions throw
"Forbidden: admin only" for non-admins, and each page renders a
"You do not have permission..." card instead of the real controls.

What it asserts, for a NON-ADMIN (clinician):

  1. /admin renders the permission-denied card and does NOT show the
     "New account" control or the "Staff accounts" management heading.
  2. /reconcile renders the permission-denied card and does NOT show the
     "Cross-project sync review" controls (no "Refresh" button).
  3. The admin server functions themselves reject the caller:
       - listStaff()          -> Forbidden
       - createStaff()        -> Forbidden
       - getReconciliation()  -> Forbidden
       - reconcilePartner()   -> Forbidden

And, for an ADMIN:

  4. /admin shows the "Staff accounts" heading AND the "New account" control.
  5. /reconcile shows the "Cross-project sync review" heading AND the "Refresh"
     control.
  6. listStaff() and getReconciliation() succeed (return without an auth error).

Two throwaway users (one clinician, one admin) are created and cleaned up via
the Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/admin-access-control.e2e.py
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
ADMIN_MODULE = "/src/lib/admin.functions.ts"
RECON_MODULE = "/src/lib/reconcile.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2E-ADMINACCESS-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_user(role, suffix):
    email = f"{MARKER.lower()}-{suffix}@example.com"
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
        json={"user_id": uid, "role": role},
        timeout=30,
    ).raise_for_status()
    return uid, email


def sign_in(email):
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def delete_user(user_id):
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


CALL_SERVER_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn({ data: arg.data });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def call_fn(page, module, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": module, "name": name, "data": data}
    )


def is_forbidden(outcome):
    if outcome["ok"]:
        return False
    msg = outcome["error"].lower()
    return "forbidden" in msg or "permission" in msg or "admin only" in msg


def restore_session(page, session):
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [STORAGE_KEY, json.dumps(session)],
    )


def main():
    clinician_id = admin_id = None
    try:
        clinician_id, clinician_email = create_user("clinician", "clin")
        admin_id, admin_email = create_user("admin", "admin")
        clinician_session = sign_in(clinician_email)
        admin_session = sign_in(admin_email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 1800})
            page = context.new_page()

            # ================= NON-ADMIN (clinician) =================
            restore_session(page, clinician_session)

            # ---- 1. /admin shows permission-denied, hides controls ----
            page.goto(f"{BASE_URL}/admin", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"clinician unexpectedly bounced to /auth: {page.url}"
            expect(
                page.get_by_text("You do not have permission to manage staff accounts.")
            ).to_be_visible(timeout=15000)
            expect(page.get_by_role("button", name="New account")).to_have_count(0)
            expect(page.get_by_role("heading", name="Staff accounts")).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "admin_access_clinician_admin.png"))

            # ---- 2. /reconcile shows permission-denied, hides controls ----
            page.goto(f"{BASE_URL}/reconcile", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"clinician unexpectedly bounced to /auth: {page.url}"
            expect(
                page.get_by_text("You do not have permission to review cross-project sync.")
            ).to_be_visible(timeout=15000)
            expect(page.get_by_role("button", name="Refresh")).to_have_count(0)
            expect(
                page.get_by_role("heading", name="Cross-project sync review")
            ).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "admin_access_clinician_reconcile.png"))

            # ---- 3. The admin server functions reject the clinician ----
            checks = [
                ("listStaff", ADMIN_MODULE, "listStaff", {}),
                (
                    "createStaff",
                    ADMIN_MODULE,
                    "createStaff",
                    {
                        "email": f"{MARKER.lower()}-should-not-exist@example.com",
                        "password": PASSWORD,
                        "display_name": "Nope",
                        "role": "clinician",
                    },
                ),
                ("getReconciliation", RECON_MODULE, "getReconciliation", {}),
                (
                    "reconcilePartner",
                    RECON_MODULE,
                    "reconcilePartner",
                    {"entity": "notifications", "ids": "all"},
                ),
            ]
            for label, module, fn, data in checks:
                outcome = call_fn(page, module, fn, data)
                assert is_forbidden(outcome), (
                    f"{label} should be Forbidden for a clinician, got: {outcome}"
                )

            # ================= ADMIN =================
            page.evaluate("() => window.localStorage.clear()")
            restore_session(page, admin_session)

            # ---- 4. /admin shows the real management controls ----
            page.goto(f"{BASE_URL}/admin", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"admin unexpectedly bounced to /auth: {page.url}"
            expect(page.get_by_role("heading", name="Staff accounts")).to_be_visible(
                timeout=15000
            )
            expect(page.get_by_role("button", name="New account")).to_be_visible()
            expect(
                page.get_by_text("You do not have permission to manage staff accounts.")
            ).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "admin_access_admin_admin.png"))

            # ---- 5. /reconcile shows the real review controls ----
            page.goto(f"{BASE_URL}/reconcile", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"admin unexpectedly bounced to /auth: {page.url}"
            expect(
                page.get_by_role("heading", name="Cross-project sync review")
            ).to_be_visible(timeout=15000)
            expect(page.get_by_role("button", name="Refresh")).to_be_visible()
            expect(
                page.get_by_text("You do not have permission to review cross-project sync.")
            ).to_have_count(0)
            page.screenshot(path=str(SCREENSHOTS / "admin_access_admin_reconcile.png"))

            # ---- 6. The admin server functions succeed for the admin ----
            staff = call_fn(page, ADMIN_MODULE, "listStaff", {})
            assert not is_forbidden(staff), f"listStaff wrongly forbidden for admin: {staff}"
            assert staff["ok"], f"listStaff should succeed for admin: {staff}"

            recon = call_fn(page, RECON_MODULE, "getReconciliation", {})
            assert not is_forbidden(recon), (
                f"getReconciliation wrongly forbidden for admin: {recon}"
            )
            # getReconciliation may fail for non-auth reasons (partner bridge
            # unreachable in the sandbox); we only require it not be an auth block.

            browser.close()

        print("PASS: clinician blocked from admin + reconcile controls; admin has full access")
        return 0
    finally:
        delete_user(clinician_id)
        delete_user(admin_id)


if __name__ == "__main__":
    sys.exit(main())
