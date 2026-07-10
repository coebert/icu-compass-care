"""
End-to-end test: driving patients through the real Status-tab UI and verifying
the exported handover PDF shows the correct status label and the matching
discharge / died details at each stage.

The app enforces a clinical lifecycle: "discharged" and "died" are TERMINAL
(see TRANSITIONS in src/lib/patients.functions.ts) — a discharged patient can
never become "died" and vice versa. So the Admitted -> Discharged -> Died
sequence cannot happen on ONE record. This test therefore exercises both
allowed terminal transitions from Admitted across two patients and asserts the
handover PDF for every stage:

  - Patient DIS: Admitted -> Discharged (with date + destination)
  - Patient DEA: Admitted -> Died (with date of death)

The "Location / status" column (location() in src/lib/handover-pdf.ts) renders:
  - the status label from STATUS_LABELS ("Admitted" / "Discharged" / "Died")
  - "To <discharge_destination>" ONLY while status === "discharged"
Each stage must show its own label and MUST NOT leak the other patient's
details.

Steps:
  1. Seed two ADMITTED patients on distinct beds via the admin REST API.
  2. Sign in as a throwaway clinician.
  3. STAGE ADMITTED — current view: export PDF, assert BOTH rows read
     "Admitted" and neither shows "Discharged", "Died", nor a "To ..." line.
  4. Discharge DIS (date + destination) and kill DEA (date of death) via the
     Status tab UI.
  5. STAGE TERMINAL — archive view: export PDF, assert the DIS row reads
     "Discharged" with "To <dest>" and no "Died", and the DEA row reads "Died"
     with no "Discharged" and no discharge destination.

All assertions are scoped to each patient's own row window so no other record
can satisfy them.

Throwaway clinician user + patients are created/cleaned via the admin REST API.
Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH.

Run:  python3 tests/e2e/handover-pdf-status-transition-admitted-discharged-died.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
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

MARKER = f"E2ESTATUS{int(time.time()) % 100000}"
PASSWORD = "Test-Passw0rd-123!"

DEST = f"Ward{MARKER}"  # single token -> stays on one PDF line even when packed
ADMISSION_DATE = (datetime.now(timezone.utc).date() - timedelta(days=6)).isoformat()

TODAY = datetime.now(timezone.utc)
TODAY_ISO = TODAY.date().isoformat()
DATA_DAY = f"{TODAY.month}/{TODAY.day}/{TODAY.year}"

# Two patients, each starting Admitted, each taking a different terminal path.
DIS = {"name": f"STXD.{MARKER}", "bed": "47", "target": "discharged"}
DEA = {"name": f"STXX.{MARKER}", "bed": "48", "target": "died"}
CASES = [DIS, DEA]


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


def create_admitted_patient(case):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/patients",
        headers={**admin_headers(), "Prefer": "return=representation"},
        json={
            "full_name": case["name"],
            "age": 68,
            "location_type": "icu",
            "ward": "Critical Care",
            "bed": case["bed"],
            "status": "admitted",
            "admission_date": ADMISSION_DATE,
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


def read_status(patient_id):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/patients?id=eq.{patient_id}"
        "&select=status,discharge_date,discharge_destination,date_of_death",
        headers=admin_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()[0]


def cleanup(patient_ids, user_id):
    for pid in patient_ids:
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


def packed(s):
    """Whitespace-free text so cell/line wrapping in the narrow PDF columns
    cannot split a name or label across lines and hide a match."""
    return "".join(s.split())


def extract_pdf_text(pdf_path):
    out = subprocess.run(
        ["pdftotext", "-raw", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {out.stderr}")
    return packed(out.stdout)


def row_window(packed_text, name, others):
    """Return the slice of packed PDF text belonging to the patient's row,
    bounded by the nearest following other-patient name so no other row can
    satisfy this row's assertions."""
    start = packed_text.find(packed(name))
    assert start != -1, f"patient {name!r} not found in exported PDF"
    end = len(packed_text)
    for other in others:
        pos = packed_text.find(packed(other), start + len(packed(name)))
        if pos != -1:
            end = min(end, pos)
    return packed_text[start:end]


def open_status_tab(page):
    tab = page.get_by_role("tab", name="Status")
    tab.scroll_into_view_if_needed()
    tab.click()
    expect(tab).to_have_attribute("data-state", "active", timeout=10000)
    return page.get_by_role("tabpanel")


def pick_today(page):
    page.get_by_role("button", name="DD/MM/YYYY").click()
    cell = page.locator(f"button[data-day='{DATA_DAY}']").first
    expect(cell).to_be_visible(timeout=5000)
    cell.click()


def export_archive_pdf(page, archived, expect_names, suffix):
    """From /patients, optionally toggle Archive, then Preview + Download the
    handover PDF and return its packed extracted text."""
    page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

    if archived:
        page.get_by_role("button", name="Archive").click()

    for name in expect_names:
        expect(page.get_by_text(name, exact=False).first).to_be_visible(timeout=15000)

    preview_btn = page.get_by_role("button", name="Preview PDF")
    expect(preview_btn).to_be_enabled(timeout=15000)
    preview_btn.click()

    dlg = page.get_by_role("dialog")
    download_btn = dlg.get_by_role("button", name="Download PDF")
    expect(download_btn).to_be_visible(timeout=10000)
    with page.expect_download(timeout=15000) as dl_info:
        download_btn.click()
    download = dl_info.value
    pdf_path = SCREENSHOTS / f"handover_{MARKER}_{suffix}.pdf"
    download.save_as(str(pdf_path))
    assert download.suggested_filename.lower().endswith(".pdf")

    text = extract_pdf_text(pdf_path)
    try:
        pdf_path.unlink()
    except OSError:
        pass
    return text


def set_status(page, patient_id, new_status):
    page.goto(f"{BASE_URL}/patients/{patient_id}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"bounced to /auth: {page.url}"

    panel = open_status_tab(page)
    panel.get_by_role("combobox").click()
    label = {"discharged": "Discharged", "died": "Died"}[new_status]
    page.get_by_role("option", name=label, exact=True).click()

    if new_status == "discharged":
        expect(panel.get_by_text("Discharge destination")).to_be_visible(timeout=5000)
        pick_today(page)
        panel.get_by_placeholder("e.g. Ward, another hospital, home").fill(DEST)
    else:  # died
        expect(panel.get_by_text("Date of death")).to_be_visible(timeout=5000)
        pick_today(page)

    panel.get_by_role("button", name="Update status").click()

    # Confirm persistence by polling the DB rather than the transient toast
    # (Sonner toasts auto-dismiss, which makes a fixed-timeout check flaky).
    deadline = time.time() + 15
    while time.time() < deadline:
        if read_status(patient_id)["status"] == new_status:
            return
        time.sleep(0.5)

    page.screenshot(path=str(SCREENSHOTS / f"debug_{MARKER}_{new_status}.png"))
    raise AssertionError(
        f"status did not persist as {new_status!r}: {read_status(patient_id)!r}"
    )


def main():
    user_id = None
    ids = {}
    try:
        user_id, email = create_user()
        for case in CASES:
            ids[case["name"]] = create_admitted_patient(case)
        session = sign_in(email)

        dest_packed = packed(f"To {DEST}")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 1800},
                accept_downloads=True,
            )
            page = context.new_page()

            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.evaluate(
                "([k, v]) => window.localStorage.setItem(k, v)",
                [STORAGE_KEY, json.dumps(session)],
            )

            # ---- STAGE ADMITTED: both patients in the current view ----
            text_a = export_archive_pdf(
                page, archived=False,
                expect_names=[DIS["name"], DEA["name"]], suffix="admitted",
            )
            for case in CASES:
                win = row_window(text_a, case["name"], [c["name"] for c in CASES if c is not case])
                assert "Admitted" in win, f"ADMITTED: {case['name']} missing 'Admitted'.\n{win!r}"
                assert "Discharged" not in win, f"ADMITTED: {case['name']} unexpected 'Discharged'.\n{win!r}"
                assert "Died" not in win, f"ADMITTED: {case['name']} unexpected 'Died'.\n{win!r}"
                assert dest_packed not in win, f"ADMITTED: {case['name']} unexpected destination.\n{win!r}"

            # ---- transitions Admitted -> Discharged / Died via the UI ----
            set_status(page, ids[DIS["name"]], "discharged")
            row = read_status(ids[DIS["name"]])
            assert row["discharge_destination"] == DEST, f"destination not stored: {row!r}"
            assert row["discharge_date"] == TODAY_ISO, f"discharge date not stored: {row!r}"

            set_status(page, ids[DEA["name"]], "died")
            row = read_status(ids[DEA["name"]])
            assert row["date_of_death"] == TODAY_ISO, f"date of death not stored: {row!r}"

            # ---- STAGE TERMINAL: both patients in the archive view ----
            text_t = export_archive_pdf(
                page, archived=True,
                expect_names=[DIS["name"], DEA["name"]], suffix="terminal",
            )

            win_dis = row_window(text_t, DIS["name"], [DEA["name"]])
            assert "Discharged" in win_dis, f"TERMINAL: DIS missing 'Discharged'.\n{win_dis!r}"
            assert dest_packed in win_dis, f"TERMINAL: DIS missing 'To {DEST}'.\n{win_dis!r}"
            assert "Died" not in win_dis, f"TERMINAL: DIS leaked 'Died'.\n{win_dis!r}"

            win_dea = row_window(text_t, DEA["name"], [DIS["name"]])
            assert "Died" in win_dea, f"TERMINAL: DEA missing 'Died'.\n{win_dea!r}"
            assert "Discharged" not in win_dea, f"TERMINAL: DEA leaked 'Discharged'.\n{win_dea!r}"
            assert dest_packed not in win_dea, f"TERMINAL: DEA leaked discharge destination.\n{win_dea!r}"

            browser.close()

        print(
            "PASS: handover PDF reflects each status stage — both patients show "
            "'Admitted' while active; after the UI transitions the discharged "
            f"patient shows 'Discharged' + 'To {DEST}' and the deceased patient "
            "shows 'Died' with no discharge details, and neither row leaks into "
            "the other."
        )
        return 0
    finally:
        cleanup(list(ids.values()), user_id)


if __name__ == "__main__":
    sys.exit(main())
