"""
End-to-end test: capturing a handover version, then viewing/downloading it from
the History page, works only for authenticated users and shows the saved data.

The History page (src/routes/_authenticated/patients.history.tsx) lets an admin
save a point-in-time version of the live handover ("Save version now"), then
browse versions, preview one, and download it as a PDF. Every part of that flow
is gated by server functions running under `requireSupabaseAuth`
(src/lib/handover-versions.functions.ts) plus the download guard
(src/lib/handover.functions.ts).

  LOGGED OUT
    1. Deep-link to /patients/history redirects to /auth (surface unreachable).
    2. listHandoverVersions is REJECTED (Unauthorized) and leaks no data.
    3. captureHandoverVersionNow is REJECTED (Unauthorized) — no version can be
       created by an anonymous caller.

  AFTER LOGIN (admin)
    4. "Save version now" captures a version that includes our marker patient.
    5. The version shows up in the History list and is findable by free-text
       search over the marker.
    6. Selecting the version renders a preview (the PDF iframe gets a blob src).
    7. The stored snapshot for that version contains the marker patient's saved
       clinical data.
    8. The "Download PDF" control fires a real browser download whose bytes are
       a valid PDF (start with "%PDF-").

A throwaway admin user + a marker-bearing patient are created and cleaned up via
the Supabase admin REST API.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/handover-version-history-preview-download.e2e.py
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
DOWNLOADS = Path(__file__).parent / "downloads"
DOWNLOADS.mkdir(parents=True, exist_ok=True)

VERSIONS_MODULE = "/src/lib/handover-versions.functions.ts"

STAMP = str(int(time.time()))
MARKER = f"HVER{STAMP}"
PATIENT_NAME = f"H.V. {MARKER}"
MANAGEMENT = f"Ceiling of care plan {MARKER}"
PASSWORD = "Test-Passw0rd-123!"


def admin_headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def create_admin_user():
    email = f"e2e-{MARKER.lower()}@example.com"
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=admin_headers(),
        json={"email": email, "password": PASSWORD, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    uid = r.json()["id"]
    # Admin role — "Save version now" and captureHandoverVersionNow require it.
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
            "age": 58,
            "weight_kg": 80,
            "hospital_number": f"HN{STAMP}",
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": "9",
            "status": "admitted",
            "current_admission": f"Admission {MARKER}",
            "current_management": MANAGEMENT,
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


def delete_version(version_id):
    if version_id:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/handover_versions?id=eq.{version_id}",
            headers=admin_headers(),
            timeout=30,
        )


def cleanup(patient_id, user_id, version_id):
    delete_version(version_id)
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


CALL_FN = """
async (arg) => {
  const mod = await import(arg.module);
  const fn = mod[arg.name];
  try {
    const result = await fn(arg.data ? { data: arg.data } : undefined);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
"""


def main():
    user_id = patient_id = version_id = None
    try:
        user_id, email = create_admin_user()
        patient_id = create_patient()

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            # ============ LOGGED OUT ============
            page.goto(BASE_URL, wait_until="domcontentloaded")

            # ---- 1. History deep-link redirects to /auth ----
            page.goto(f"{BASE_URL}/patients/history", wait_until="domcontentloaded")
            page.wait_for_url("**/auth", timeout=15000)
            assert page.url.rstrip("/").endswith("/auth"), (
                f"expected redirect to /auth, got {page.url}"
            )
            assert not page.get_by_role("button", name="Save version now").count(), (
                "Save version now control rendered while logged out"
            )

            # ---- 2. listHandoverVersions rejected, no leak ----
            out = page.evaluate(
                CALL_FN,
                {"module": VERSIONS_MODULE, "name": "listHandoverVersions", "data": {}},
            )
            assert not out["ok"], "listHandoverVersions succeeded while logged out"
            assert "unauthor" in out["error"].lower(), (
                f"list rejected but not for auth: {out['error']}"
            )
            assert MARKER not in out["error"], f"list leaked data: {out['error']!r}"

            # ---- 3. captureHandoverVersionNow rejected ----
            out = page.evaluate(
                CALL_FN,
                {"module": VERSIONS_MODULE, "name": "captureHandoverVersionNow"},
            )
            assert not out["ok"], "capture succeeded while logged out"
            assert "unauthor" in out["error"].lower(), (
                f"capture rejected but not for auth: {out['error']}"
            )
            print("OK  logged out: history redirects, list + capture Unauthorized")

            # ============ AFTER LOGIN (admin) ============
            session = sign_in(email)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            page.goto(f"{BASE_URL}/patients/history", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, (
                f"redirected to /auth while authenticated: {page.url}"
            )

            # ---- 4. Save a version now (admin control) ----
            save_btn = page.get_by_role("button", name="Save version now")
            expect(save_btn).to_be_visible(timeout=15000)
            save_btn.click()
            expect(page.get_by_text("Saved version", exact=False).first).to_be_visible(
                timeout=20000
            )

            # Grab the captured version id from the server list (newest first).
            listed = page.evaluate(
                CALL_FN,
                {"module": VERSIONS_MODULE, "name": "listHandoverVersions", "data": {}},
            )
            assert listed["ok"], f"authenticated list failed: {listed.get('error')!r}"
            rows = listed["result"]["rows"]
            assert rows, "no versions returned after capture"
            version_id = rows[0]["id"]
            assert rows[0]["patient_count"] >= 1, "captured version has no patients"

            # ---- 5. Free-text search finds the version by the marker ----
            search = page.evaluate(
                CALL_FN,
                {
                    "module": VERSIONS_MODULE,
                    "name": "listHandoverVersions",
                    "data": {"q": MARKER},
                },
            )
            assert search["ok"], f"search failed: {search.get('error')!r}"
            found_ids = [r["id"] for r in search["result"]["rows"]]
            assert version_id in found_ids, (
                "marker search did not return the captured version"
            )

            # ---- 6. Selecting the version renders a preview ----
            page.get_by_role("textbox", name="Search (patient or text)").fill(MARKER)
            first_version = page.locator("button", has_text="patient").first
            expect(first_version).to_be_visible(timeout=15000)
            first_version.click()
            iframe = page.locator("iframe[title='Saved handover preview']")
            expect(iframe).to_be_visible(timeout=20000)
            src = iframe.get_attribute("src") or ""
            assert src.startswith("blob:"), f"preview iframe has no blob src: {src!r}"
            page.screenshot(
                path=str(SCREENSHOTS / "handover_version_history_preview.png")
            )

            # ---- 7. Stored snapshot contains the marker patient's saved data ----
            one = page.evaluate(
                CALL_FN,
                {
                    "module": VERSIONS_MODULE,
                    "name": "getHandoverVersion",
                    "data": {"id": version_id},
                },
            )
            assert one["ok"], f"getHandoverVersion failed: {one.get('error')!r}"
            snapshot = one["result"]["snapshot"]
            snap_text = json.dumps(snapshot)
            assert PATIENT_NAME in snap_text, "snapshot missing marker patient name"
            assert MANAGEMENT in snap_text, "snapshot missing marker management text"

            # ---- 8. Download PDF fires a valid .pdf ----
            with page.expect_download(timeout=20000) as dl_info:
                page.get_by_role("button", name="Download PDF").click()
            download = dl_info.value
            assert download.suggested_filename.lower().endswith(".pdf"), (
                f"download is not a .pdf: {download.suggested_filename!r}"
            )
            saved = DOWNLOADS / download.suggested_filename
            download.save_as(str(saved))
            head = saved.read_bytes()[:5]
            assert head == b"%PDF-", (
                f"downloaded file is not a valid PDF (starts with {head!r})"
            )
            page.screenshot(
                path=str(SCREENSHOTS / "handover_version_history_downloaded.png")
            )
            print(
                "OK  logged in: version saved, searchable, previews, snapshot has "
                f"data, and a valid .pdf ({download.suggested_filename}) downloads"
            )

            browser.close()

        print(
            "PASS: handover version capture/preview/download is Unauthorized when "
            "logged out and shows the saved patient data after login"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id, version_id)


if __name__ == "__main__":
    sys.exit(main())
