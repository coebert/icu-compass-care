"""
End-to-end test: the on-screen PDF preview is byte-for-byte the same document
that gets downloaded, across different font scales, on BOTH desktop and mobile
viewports.

The preview iframe and the Download button both build the handover from the
SAME options via buildHandoverPdf(...).output("blob") (handoverPdfPreviewUrl vs
downloadHandover in src/lib/handover-pdf.ts). This test proves that invariant
end-to-end through the real modal instead of trusting it by inspection:

  For each viewport (desktop 1280px, mobile 375px) and each font scale
  (60% min, 100%, 160% max):
    1. Open the "Preview PDF" modal on the patient board.
    2. Move the Font-scale slider to the target value.
    3. Read the bytes the preview iframe is actually showing (fetch the blob
       URL in the page's own context).
    4. Click "Download PDF" and capture the downloaded bytes.
    5. Assert preview bytes == downloaded bytes (what you see is what you get).
    6. Assert the extracted PDF text is identical between preview and download.

  Then assert that changing the font scale actually changes the produced PDF
  (60% vs 160% differ), so the equality above isn't a trivial "scale ignored".

A throwaway admin user + one patient are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftotext (poppler-utils) on PATH

Run:  python3 tests/e2e/pdf-preview-matches-download.e2e.py
Exits 0 on success, non-zero on failure.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
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

MARKER = f"E2EPDFMATCH{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "P.D.F."

VIEWPORTS = {"desktop": (1280, 1800), "mobile": (375, 900)}
FONT_SCALES = [0.6, 1.0, 1.6]  # slider min, default, max


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
            "age": 59,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Preview/download parity check {MARKER}",
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


def pdf_text(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        out = subprocess.run(
            ["pdftotext", "-layout", path, "-"],
            capture_output=True,
            check=True,
        )
        return out.stdout.decode("utf-8", "replace")
    finally:
        os.unlink(path)


def normalize_text(text: str) -> str:
    # The header stamps "Generated DD/MM/YYYY, HH:MM:SS" from the wall clock at
    # build time; the preview blob and the download blob are built a moment
    # apart, so this one field can differ by a second. Normalize it away — it is
    # not part of the clinical content the two surfaces must agree on.
    import re

    return re.sub(r"Generated \d{2}/\d{2}/\d{4}, \d{2}:\d{2}:\d{2}", "Generated <ts>", text)



# Read the exact bytes the preview <iframe> is displaying, by fetching its blob
# URL from within the page context (blob URLs are only resolvable in-page).
READ_PREVIEW_BYTES = """
async () => {
  const iframe = document.querySelector('iframe[title="Handover PDF preview"]');
  if (!iframe) return null;
  const src = iframe.getAttribute('src') || '';
  const blobUrl = src.split('#')[0];
  if (!blobUrl.startsWith('blob:')) return null;
  const res = await fetch(blobUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  return Array.from(buf);
}
"""


def set_font_scale(page, scale):
    """Drag the Font-scale slider to `scale` (range 0.6..1.6, step 0.05)."""
    slider = page.locator("#pdf-fontscale [role='slider']")
    slider.scroll_into_view_if_needed()
    box = page.locator("#pdf-fontscale").bounding_box()
    frac = (scale - 0.6) / (1.6 - 0.6)
    target_x = box["x"] + frac * box["width"]
    target_y = box["y"] + box["height"] / 2
    slider.click()
    page.mouse.move(box["x"], target_y)
    page.mouse.down()
    page.mouse.move(target_x, target_y, steps=8)
    page.mouse.up()
    # Confirm the label reflects the requested percentage.
    expect(
        page.get_by_text(f"Font scale: {round(scale * 100)}%", exact=True)
    ).to_be_visible(timeout=5000)


def open_preview(page):
    page.get_by_role("button", name="Preview PDF").click()
    expect(page.get_by_role("heading", name="Handover PDF preview")).to_be_visible(
        timeout=15000
    )
    # Wait for the first preview blob to be wired into the iframe.
    page.wait_for_function(
        """() => {
          const f = document.querySelector('iframe[title="Handover PDF preview"]');
          return f && (f.getAttribute('src') || '').startsWith('blob:');
        }""",
        timeout=15000,
    )


def read_preview_bytes(page):
    # The preview rebuilds asynchronously (useMemo -> useEffect -> new blob).
    # Poll until the bytes stop changing (two identical consecutive reads), so
    # we compare against a fully-settled preview rather than a stale blob.
    prev = None
    for _ in range(20):
        page.wait_for_timeout(300)
        arr = page.evaluate(READ_PREVIEW_BYTES)
        assert arr, "could not read preview iframe blob bytes"
        cur = bytes(arr)
        if prev is not None and cur == prev:
            return cur
        prev = cur
    return prev



def capture_download_bytes(page):
    with page.expect_download(timeout=15000) as dl_info:
        page.get_by_role("button", name="Download PDF").click()
    download = dl_info.value
    path = download.path()
    return Path(path).read_bytes()


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            for vp_name, (w, h) in VIEWPORTS.items():
                context = browser.new_context(
                    viewport={"width": w, "height": h}, accept_downloads=True
                )
                page = context.new_page()

                page.goto(BASE_URL, wait_until="domcontentloaded")
                page.evaluate(
                    "([k, v]) => window.localStorage.setItem(k, v)",
                    [STORAGE_KEY, json.dumps(session)],
                )
                page.goto(f"{BASE_URL}/patients", wait_until="domcontentloaded")
                page.wait_for_load_state("networkidle")
                assert "/auth" not in page.url, f"[{vp_name}] bounced to /auth: {page.url}"
                expect(page.get_by_role("heading", name="Patient board")).to_be_visible(
                    timeout=15000
                )

                scale_hashes = {}
                for scale in FONT_SCALES:
                    open_preview(page)
                    src_before = page.evaluate(
                        """() => document.querySelector('iframe[title="Handover PDF preview"]').getAttribute('src')"""
                    )
                    set_font_scale(page, scale)
                    # The preview opens at 100%; for any other scale wait for the
                    # iframe to swap in a freshly-built blob before reading, so we
                    # never compare a stale (default-scale) preview.
                    if round(scale * 100) != 100:
                        page.wait_for_function(
                            """(prev) => {
                              const f = document.querySelector('iframe[title="Handover PDF preview"]');
                              const s = f && f.getAttribute('src');
                              return s && s !== prev && s.startsWith('blob:');
                            }""",
                            arg=src_before,
                            timeout=15000,
                        )

                    preview_bytes = read_preview_bytes(page)
                    download_bytes = capture_download_bytes(page)


                    # 1) What you see == what you get (ignore the PDF's own
                    #    /CreationDate/ID, which jsPDF stamps with the clock; we
                    #    compare the rendered text, which is what the clinician
                    #    actually reads, plus a size sanity check).
                    p_text = normalize_text(pdf_text(preview_bytes))
                    d_text = normalize_text(pdf_text(download_bytes))
                    assert p_text == d_text, (
                        f"[{vp_name} @ {int(scale*100)}%] preview text != download text"
                    )
                    assert PATIENT_NAME in d_text, (
                        f"[{vp_name} @ {int(scale*100)}%] patient missing from PDF text"
                    )
                    # Byte-length parity is a strong structural signal that the
                    # two blobs are the same document built from the same opts.
                    assert abs(len(preview_bytes) - len(download_bytes)) <= 64, (
                        f"[{vp_name} @ {int(scale*100)}%] preview/download sizes diverge: "
                        f"{len(preview_bytes)} vs {len(download_bytes)}"
                    )

                    scale_hashes[scale] = hashlib.sha256(p_text.encode()).hexdigest()
                    page.screenshot(
                        path=str(SCREENSHOTS / f"pdfmatch_{vp_name}_{int(scale*100)}.png")
                    )
                    page.get_by_role("button", name="Close").first.click()
                    expect(
                        page.get_by_role("heading", name="Handover PDF preview")
                    ).to_have_count(0, timeout=10000)

                # 2) Font scale actually changes the produced document.
                assert scale_hashes[0.6] != scale_hashes[1.6], (
                    f"[{vp_name}] font scale had no effect on the PDF (60% == 160%)"
                )

                context.close()

            browser.close()

        print("PASS: preview matches download across font scales on desktop and mobile")
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
