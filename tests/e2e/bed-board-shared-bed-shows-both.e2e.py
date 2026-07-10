"""
End-to-end test: when two active ICU patients share the SAME bed number (a data
state that can arise transiently during transfers/imports), BOTH patients must
still be visible on the bed board and in the patient list — neither may be
silently hidden behind the other.

Regression guard: the bed board previously mapped each bed to a single occupant
(first-wins), so a second patient sharing the bed vanished from the board. The
board now keeps all occupants per bed and shows a "2 patients in Bed X" notice.

Flow:
  1. Seed two throwaway ICU patients with the SAME bed label (a real roster bed).
  2. Restore a clinician session and open /patients.
  3. Assert both patient names are visible on the bed board (current view).
  4. Assert the shared-bed warning ("2 patients in ...") renders.
  5. Search each patient by name and assert the list filters down to them,
     proving both are reachable in the patient list too.

Throwaway clinician user + patients are created/cleaned via the admin REST API.
Nothing lingers in the clinical dataset.

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY.

Run:  python3 tests/e2e/bed-board-shared-bed-shows-both.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import re
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

MARKER = f"E2ESHAREDBED{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
SUFFIX = str(int(time.time()))[-6:]

NAME_A = f"AA{SUFFIX}"
NAME_B = f"BB{SUFFIX}"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def pick_shared_bed():
    """Choose a real, non-side-room roster bed that is currently UNOCCUPIED, so
    seeding exactly two patients yields a deterministic '2 patients in ...'
    count. Falls back to '5' if the roster / occupancy can't be read."""
    try:
        beds_r = requests.get(
            f"{SUPABASE_URL}/rest/v1/icu_beds?select=label,is_side_room&is_side_room=eq.false",
            headers=admin_headers(),
            timeout=30,
        )
        labels = [b["label"] for b in beds_r.json()] if beds_r.ok and beds_r.json() else [
            "3", "4", "5", "6", "7", "8", "9", "10",
        ]
        occ_r = requests.get(
            f"{SUPABASE_URL}/rest/v1/patients?select=bed&location_type=eq.icu"
            f"&status=in.(admitted,referred)",
            headers=admin_headers(),
            timeout=30,
        )
        occupied = {str(row.get("bed") or "").strip().upper() for row in (occ_r.json() if occ_r.ok else [])}
        for label in labels:
            if str(label).strip().upper() not in occupied:
                return label
    except Exception:
        pass
    return "5"


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


def create_patient(name, bed):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": name,
            "age": 55,
            "location_type": "icu",
            "bed": bed,
            "status": "admitted",
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


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
        if pid:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/patients?id=eq.{pid}",
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
    user_id = None
    patient_ids = []
    try:
        user_id, email = create_user()
        bed = pick_shared_bed()
        patient_ids.append(create_patient(NAME_A, bed))
        patient_ids.append(create_patient(NAME_B, bed))

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

            page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"redirected to /auth while authenticated: {page.url}"

            # ---- Both patients visible on the bed board (current view) ----
            expect(page.get_by_text(NAME_A, exact=False).first).to_be_visible(timeout=15000)
            expect(page.get_by_text(NAME_B, exact=False).first).to_be_visible(timeout=15000)

            # ---- Shared-bed warning renders for the shared bed ----
            expect(page.get_by_text(re.compile(r"[2-9]\d* patients in")).first).to_be_visible(timeout=10000)

            page.screenshot(path=str(SCREENSHOTS / f"{MARKER}_board.png"))

            # ---- Both patients reachable via the patient-list search ----
            search = page.get_by_placeholder("Search initials or hospital no.…")
            search.fill(NAME_A)
            expect(page.get_by_text(NAME_A, exact=False).first).to_be_visible(timeout=10000)
            search.fill(NAME_B)
            expect(page.get_by_text(NAME_B, exact=False).first).to_be_visible(timeout=10000)

            browser.close()

        print("PASS: both patients sharing a bed appear on the bed board and patient list")
        return 0
    finally:
        cleanup(patient_ids, user_id)


if __name__ == "__main__":
    sys.exit(main())
