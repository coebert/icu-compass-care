"""
Visual regression test: the rendered handover PDF's HEADER and FOOTER bands
must be pixel-identical whether the PDF was produced from a desktop (1280px) or
a mobile (375px) viewport, so a layout/CSS change in the modal can never quietly
truncate the header title/subtitle/"Generated" stamp or the footer text/page
numbers on one form factor but not the other.

Why this matters: the header (title, subtitle, right-aligned "Generated <ts>")
and footer (custom text · "Page X of Y") are drawn by buildHandoverPdf(...) on
an A4 canvas, so they SHOULD be viewport-independent. This test proves that
invariant visually instead of trusting it:

  1. Create an admin + one patient (Supabase admin REST API).
  2. For each viewport (desktop, mobile):
       - Open the "Preview PDF" modal on the patient board.
       - Type a deliberately long header title, subtitle and footer text — the
         kind of content most likely to expose truncation differences.
       - Download the PDF and capture the bytes.
  3. Render each downloaded PDF's first page to a PNG at 150 DPI (pdftoppm).
  4. Crop the top HEADER band and bottom FOOTER band from each render.
  5. Assert the desktop header band == mobile header band and desktop footer
     band == mobile footer band, pixel-for-pixel (any diff => a truncation or
     layout regression on one viewport). The "Generated" timestamp lives in the
     header, so its seconds field is masked out before comparison.
  6. Assert (via pdftotext) that the full long title/subtitle/footer text is
     actually present — i.e. the bands agree AND nothing was clipped on both.

A throwaway admin user + one patient are created and cleaned up via the
Supabase admin REST API. Nothing lingers in the clinical dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
  pdftoppm + pdftotext (poppler-utils) on PATH, Pillow

Run:  python3 tests/e2e/handover-pdf-header-footer-visual-regression.e2e.py
Exits 0 on success, non-zero on failure.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

import requests
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]

PROJECT_REF = urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0]
STORAGE_KEY = f"sb-{PROJECT_REF}-auth-token"

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

MARKER = f"E2EPDFVR{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"
PATIENT_NAME = "V.R.T."

# Deliberately long header/footer content — the content most likely to reveal
# truncation differences between viewports if any layout coupling exists.
LONG_TITLE = "Salisbury District Hospital Critical Care Handover Sheet"
LONG_SUBTITLE = "Level 3 Intensive Care Unit — Consultant Ward Round Summary"
LONG_FOOTER = (
    "Confidential patient-identifiable information — handle per SDH information "
    "governance policy and destroy securely after handover"
)

VIEWPORTS = {"desktop": (1280, 1800), "mobile": (375, 900)}
RENDER_DPI = 150
# A4 at 150 DPI is ~1240 x 1754 px. Header sits in the top band, footer in the
# bottom band; crop generous bands that fully contain them.
HEADER_BAND_PX = 170  # top strip
FOOTER_BAND_PX = 90   # bottom strip


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
            "age": 64,
            "location_type": "icu",
            "ward": "Critical Care",
            "status": "admitted",
            "current_management": f"Header/footer visual regression {MARKER}",
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
            ["pdftotext", "-layout", path, "-"], capture_output=True, check=True
        )
        return out.stdout.decode("utf-8", "replace")
    finally:
        os.unlink(path)


def render_first_page(data: bytes) -> Image.Image:
    """Render page 1 of the PDF to a PIL image at RENDER_DPI."""
    with tempfile.TemporaryDirectory() as d:
        pdf_path = Path(d) / "doc.pdf"
        pdf_path.write_bytes(data)
        out_prefix = Path(d) / "page"
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(RENDER_DPI), "-f", "1", "-l", "1",
             str(pdf_path), str(out_prefix)],
            check=True,
            capture_output=True,
        )
        pngs = sorted(Path(d).glob("page*.png"))
        assert pngs, "pdftoppm produced no page image"
        return Image.open(pngs[0]).convert("RGB")


def header_band(img: Image.Image) -> Image.Image:
    return img.crop((0, 0, img.width, HEADER_BAND_PX))


def footer_band(img: Image.Image) -> Image.Image:
    return img.crop((0, img.height - FOOTER_BAND_PX, img.width, img.height))


def mask_generated_stamp(band: Image.Image) -> Image.Image:
    """The right-aligned "Generated <ts>" is stamped from the wall clock and
    differs by seconds between the two downloads. White it out in the top-right
    quadrant so the comparison is on the static header layout, not the clock."""
    out = band.copy()
    white = Image.new("RGB", (out.width // 2, out.height), (255, 255, 255))
    out.paste(white, (out.width // 2, 0))
    return out


def bands_identical(a: Image.Image, b: Image.Image) -> bool:
    if a.size != b.size:
        return False
    diff = ImageChops.difference(a, b)
    return diff.getbbox() is None


def fill_header_footer(page):
    def set_field(field_id, value):
        el = page.locator(f"#{field_id}")
        el.scroll_into_view_if_needed()
        el.fill(value)
    set_field("pdf-title", LONG_TITLE)
    set_field("pdf-subtitle", LONG_SUBTITLE)
    set_field("pdf-footer", LONG_FOOTER)


def open_preview(page):
    page.get_by_role("button", name="Preview PDF").click()
    expect(page.get_by_role("heading", name="Handover PDF preview")).to_be_visible(
        timeout=15000
    )
    page.wait_for_function(
        """() => {
          const f = document.querySelector('iframe[title="Handover PDF preview"]');
          return f && (f.getAttribute('src') || '').startsWith('blob:');
        }""",
        timeout=15000,
    )


def capture_download_bytes(page):
    with page.expect_download(timeout=15000) as dl_info:
        page.get_by_role("button", name="Download PDF").click()
    return Path(dl_info.value.path()).read_bytes()


def main():
    user_id = patient_id = None
    try:
        user_id, email = create_user()
        patient_id = create_patient()
        session = sign_in(email)

        renders = {}

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

                open_preview(page)
                fill_header_footer(page)
                # Let the preview rebuild with the new header/footer before download.
                page.wait_for_timeout(1200)
                data = capture_download_bytes(page)

                text = pdf_text(data)
                # Nothing clipped: the full long strings survive into the PDF text.
                for label, value in (
                    ("title", LONG_TITLE),
                    ("subtitle", LONG_SUBTITLE),
                    ("footer", LONG_FOOTER),
                ):
                    assert value in " ".join(text.split()), (
                        f"[{vp_name}] {label} text truncated/missing in PDF"
                    )

                img = render_first_page(data)
                renders[vp_name] = img
                header_band(img).save(
                    SCREENSHOTS / f"pdfvr_{vp_name}_header.png"
                )
                footer_band(img).save(
                    SCREENSHOTS / f"pdfvr_{vp_name}_footer.png"
                )

                page.get_by_role("button", name="Close").first.click()
                context.close()

            browser.close()

        d_img, m_img = renders["desktop"], renders["mobile"]

        d_header = mask_generated_stamp(header_band(d_img))
        m_header = mask_generated_stamp(header_band(m_img))
        assert bands_identical(d_header, m_header), (
            "HEADER band differs between desktop and mobile — possible "
            "title/subtitle truncation regression"
        )

        d_footer = footer_band(d_img)
        m_footer = footer_band(m_img)
        assert bands_identical(d_footer, m_footer), (
            "FOOTER band differs between desktop and mobile — possible "
            "footer text/page-number truncation regression"
        )

        print(
            "PASS: header and footer bands are pixel-identical across desktop "
            "and mobile, with no truncation of long header/footer content"
        )
        return 0
    finally:
        cleanup(patient_id, user_id)


if __name__ == "__main__":
    sys.exit(main())
