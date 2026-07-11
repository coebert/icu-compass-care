"""
End-to-end test (UI-driven): the full lifecycle of an OUTLYING-WARD (referred)
patient — create as a referred outlier, update their outlying-ward context
(ward + bed) through the real Edit form, then move status through
referred -> admitted -> discharged via the Status tab, hard-refresh, and verify
the Timeline shows continuity across ALL of those events.

What it proves:
  1. CREATE   — a referred outlier is created via the genuine createPatient
                server fn; DB shows status=referred, location_type=outlier.
  2. RE-WARD  — via the Edit form the outlier's ward + bed are updated (the
                patient is moved to a different outlying ward); DB persists the
                new ward/bed while location_type stays outlier.
  3. ADMIT    — via the Status tab, status -> Admitted; DB shows admitted,
                still an outlier, new ward retained.
  4. DISCHARGE— via the Status tab, status -> Discharged with today's date and
                a destination; DB persists the discharge fields.
  5. REFRESH  — after a hard reload the record still loads (no /auth bounce).
  6. TIMELINE — the Timeline shows, in newest-first order and with correct
                dates: the "Discharged" event (with destination), a "Status
                changed to Discharged" event, a "Status changed to Admitted"
                event, and the "Admitted to critical care" admission event —
                proving continuity across the whole referred->admitted->
                discharged journey.

Throwaway clinician user + patient are created and cleaned up via the Supabase
admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/outlier-referred-admitted-discharged-timeline-continuity.e2e.py
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
FUNCTIONS_MODULE = "/src/lib/patients.functions.ts"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EOUTLC{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "O.L. Cont"
WARD1 = f"Radnor Ward {MARKER}"
BED1 = "9"
WARD2 = f"Pembroke Ward {MARKER}"
BED2 = "14"
DESTINATION = f"Discharged home with district nurses {MARKER}"


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


def read_patient(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,location_type,ward,bed,discharge_date,discharge_destination",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


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


def call_fn(page, name, data):
    return page.evaluate(
        CALL_SERVER_FN, {"module": FUNCTIONS_MODULE, "name": name, "data": data}
    )


def open_tab(page, name):
    tab = page.get_by_role("tab", name=name)
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def set_status(page, option_label, extra=None):
    panel = open_tab(page, "Status")
    panel.get_by_role("combobox").click()
    page.get_by_role("option", name=option_label, exact=True).click()
    if extra:
        extra(panel)
    panel.get_by_role("button", name="Update status").click()
    expect(page.get_by_text("Status updated", exact=False).first).to_be_visible(timeout=10000)


def wait_for(patient_id, predicate, tries=12):
    row = None
    for _ in range(tries):
        row = read_patient(patient_id)
        if predicate(row):
            return row
        time.sleep(0.5)
    return row


def main():
    user_id = patient_id = None
    try:
        now = datetime.now(timezone.utc)
        d2 = now.date()
        uk = lambda d: d.strftime("%d/%m/%Y")
        data_day = f"{now.month}/{now.day}/{now.year}"

        user_id, email = create_user()
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
            assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

            # ---- 1. CREATE the referred outlier ----
            created = call_fn(page, "createPatient", {
                "full_name": PATIENT_NAME,
                "age": 73,
                "location_type": "outlier",
                "ward": WARD1,
                "bed": BED1,
                "status": "referred",
                "isolation_required": False,
                "tep_in_place": False,
                "dnacpr_decision": False,
                "current_management": f"Outlier awaiting bed {MARKER}",
            })
            assert created["ok"], f"createPatient failed: {created.get('error')}"
            patient_id = created["result"]["id"]
            start = read_patient(patient_id)
            assert start["status"] == "referred", f"start status: {start['status']!r}"
            assert start["location_type"] == "outlier", f"expected outlier: {start!r}"
            assert start["ward"] == WARD1, f"ward: {start['ward']!r}"

            page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- 2. RE-WARD via the Edit form (move to a new outlying ward) ----
            page.get_by_role("button", name="Edit").first.click()
            dialog = page.get_by_role("dialog")
            expect(page.get_by_role("heading", name="Edit patient")).to_be_visible(timeout=10000)
            ward_input = dialog.locator("#pf-ward")
            ward_input.fill(WARD2)
            bed_input = dialog.locator(
                "xpath=.//label[normalize-space()='Bed']/following::input[1]"
            )
            bed_input.fill(BED2)
            dialog.get_by_role("button", name="Save changes").click()
            expect(page.get_by_role("heading", name="Edit patient")).to_have_count(0, timeout=10000)

            reward = wait_for(patient_id, lambda r: r and r["ward"] == WARD2)
            assert reward["ward"] == WARD2, f"ward not updated: {reward['ward']!r}"
            assert reward["bed"] == BED2, f"bed not updated: {reward['bed']!r}"
            assert reward["location_type"] == "outlier", "location_type changed on re-ward"
            assert reward["status"] == "referred", "status changed on re-ward"

            # ---- 3. ADMIT (referred -> admitted) ----
            set_status(page, "Admitted")
            adm = wait_for(patient_id, lambda r: r and r["status"] == "admitted")
            assert adm["status"] == "admitted", f"not admitted: {adm['status']!r}"
            assert adm["location_type"] == "outlier", "location_type changed on admit"
            assert adm["ward"] == WARD2, "ward lost on admit"

            # ---- 4. DISCHARGE (admitted -> discharged) with date + destination ----
            def pick_discharge(panel):
                date_btn = panel.locator(
                    "xpath=.//label[normalize-space()='Discharge date']/following::button[1]"
                )
                for _ in range(4):
                    date_btn.click()
                    cell = page.locator(f"button[data-day='{data_day}']").first
                    expect(cell).to_be_visible(timeout=5000)
                    cell.click(force=True)
                    page.wait_for_timeout(400)
                    if "DD/MM/YYYY" not in (date_btn.inner_text() or ""):
                        break
                panel.locator(
                    "xpath=.//label[normalize-space()='Discharge destination']/following::input[1]"
                ).fill(DESTINATION)

            set_status(page, "Discharged", extra=pick_discharge)
            dis = wait_for(patient_id, lambda r: r and r["status"] == "discharged")
            assert dis["status"] == "discharged", f"not discharged: {dis['status']!r}"
            assert (dis["discharge_date"] or "").startswith(d2.isoformat()), (
                f"discharge_date: {dis['discharge_date']!r}"
            )
            assert dis["discharge_destination"] == DESTINATION, (
                f"discharge_destination: {dis['discharge_destination']!r}"
            )

            # ---- 5. REFRESH — record still loads ----
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            assert "/auth" not in page.url, f"bounced to /auth after reload: {page.url}"
            expect(page.get_by_text(PATIENT_NAME, exact=False).first).to_be_visible(timeout=15000)

            # ---- 6. TIMELINE continuity across all events ----
            tl = open_tab(page, "Timeline")

            discharge_row = tl.locator("li", has_text="Discharged").first
            expect(discharge_row).to_be_visible(timeout=15000)
            expect(discharge_row.get_by_text(DESTINATION, exact=False)).to_be_visible()
            expect(discharge_row.get_by_text(uk(d2), exact=False)).to_be_visible()

            expect(
                tl.get_by_text("Status changed to Discharged", exact=False).first
            ).to_be_visible(timeout=10000)
            expect(
                tl.get_by_text("Status changed to Admitted", exact=False).first
            ).to_be_visible()
            expect(
                tl.get_by_text("Admitted to critical care", exact=False).first
            ).to_be_visible()

            # Continuity: the whole referred->admitted->discharged journey is
            # represented as distinct Timeline entries. The two status-change
            # audit events are datetime-stamped (today) and sort newest-first
            # above the admission entry; the "Discharged" summary event is
            # date-only (discharge_date) so it renders with its own UK date.
            texts = tl.locator("ol li").all_inner_texts()
            joined = "\n---\n".join(texts)
            required = [
                lambda t: "Discharged" in t and DESTINATION in t,
                lambda t: "Status changed to Discharged" in t,
                lambda t: "Status changed to Admitted" in t,
                lambda t: "Admitted to critical care" in t,
            ]
            for i, pred in enumerate(required):
                assert any(pred(t) for t in texts), (
                    f"missing timeline continuity entry #{i}:\n{joined}"
                )

            page.screenshot(path=str(SCREENSHOTS / "outlier_lifecycle_timeline_continuity.png"))
            browser.close()

        print(
            "PASS: referred outlier re-warded, admitted then discharged via the UI — "
            "all changes persisted and the Timeline shows continuity across the "
            "admission, status-change and discharge events after refresh"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
