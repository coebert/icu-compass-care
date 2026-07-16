"""
End-to-end test: the global authenticated header lays out cleanly at common
breakpoints and never overlaps itself or overflows its row.

Drives the real ICU handover app in a headless browser as an authenticated
admin (so all nav items and the admin-only Sync button appear) and, at each
of the standard responsive breakpoints below, asserts:

  1. FITS THE ROW      — the header row is single-line at its expected height
     (no vertical wrapping of children onto extra rows).
  2. NO H-OVERFLOW     — the sticky header does not scroll horizontally
     (scrollWidth <= clientWidth) and its inner container's children all sit
     within the viewport.
  3. NO OVERLAP        — the top-level header regions (brand link, nav,
     right-hand action cluster) do not overlap each other's bounding rects.
  4. RIGHT CLUSTER OK  — the sync-status badge, optional user name, and the
     Sign out button never overlap and each stays fully on-screen.

Breakpoints exercised (chosen to match Tailwind sm / md / lg / xl and a very
narrow phone):

    320  x 720   — small mobile
    390  x 844   — iPhone-ish
    768  x 1024  — tablet portrait (Tailwind md)
    1024 x 768   — small desktop (Tailwind lg)
    1440 x 900   — desktop (Tailwind xl+)

Test data (a throwaway admin user) is created and cleaned up via the Supabase
admin REST API. Nothing lingers in the dataset.

Requires (already present in the sandbox environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY

Run:  python3 tests/e2e/header-responsive-no-overlap.e2e.py
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

MARKER = f"E2E-HDR-{int(time.time())}"
PASSWORD = "Test-Passw0rd-123!"

# Header h-14 = 3.5rem = 56px. Allow a small tolerance for sub-pixel layout,
# but anything materially taller means the header wrapped onto two lines.
HEADER_MAX_HEIGHT = 64

# name, width, height. Routes are exercised on each of these viewports.
VIEWPORTS = [
    {"name": "mobile-narrow", "width": 320, "height": 720},
    {"name": "mobile", "width": 390, "height": 844},
    {"name": "tablet", "width": 768, "height": 1024},
    {"name": "desktop-sm", "width": 1024, "height": 768},
    {"name": "desktop", "width": 1440, "height": 900},
]

# The two authenticated routes the sticky header is rendered on. We check the
# header on both, because /reconcile is where the admin-only Sync button and
# the wider content push against the right-hand cluster hardest in practice.
ROUTES = ["/patients", "/reconcile"]


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
    if user_id:
        requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=admin_headers(),
            timeout=30,
        )


def rects_overlap(a, b, tolerance=1.0):
    """Two axis-aligned rects overlap if they intersect on both axes.
    A `tolerance` of 1px absorbs sub-pixel adjacency (e.g. a 0.5px gap that
    rounds to touching)."""
    if a is None or b is None:
        return False
    ax2 = a["x"] + a["width"]
    ay2 = a["y"] + a["height"]
    bx2 = b["x"] + b["width"]
    by2 = b["y"] + b["height"]
    return (
        a["x"] + tolerance < bx2
        and b["x"] + tolerance < ax2
        and a["y"] + tolerance < by2
        and b["y"] + tolerance < ay2
    )


def check_header(page, vp, route):
    tag = f"{route} @ {vp['name']} ({vp['width']}x{vp['height']})"

    header = page.locator("header").first
    expect(header, f"{tag}: header should be visible").to_be_visible(timeout=15000)

    # ---- 1. FITS THE ROW ----
    hbox = header.bounding_box()
    assert hbox is not None, f"{tag}: header has no bounding box"
    assert hbox["height"] <= HEADER_MAX_HEIGHT, (
        f"{tag}: header wrapped onto multiple lines "
        f"(height={hbox['height']:.0f} > {HEADER_MAX_HEIGHT})"
    )

    # ---- 2. NO H-OVERFLOW ----
    # The header itself should not need to scroll horizontally.
    overflow = page.evaluate(
        "() => { const h = document.querySelector('header');"
        " return h ? { s: h.scrollWidth, c: h.clientWidth } : null; }"
    )
    assert overflow is not None, f"{tag}: could not measure header overflow"
    assert overflow["s"] <= overflow["c"] + 1, (
        f"{tag}: header overflows horizontally "
        f"(scrollWidth={overflow['s']} > clientWidth={overflow['c']})"
    )

    # ---- 3. NO OVERLAP between the top-level header regions ----
    # The header row has three siblings inside its container:
    #   [brand link] [nav] [right-hand action cluster]
    # We measure them structurally via the DOM (first child = brand, the
    # <nav>, last child = right cluster) so the test doesn't need to know
    # which labels the current breakpoint chose to hide.
    region_boxes = page.evaluate(
        """() => {
          const header = document.querySelector('header');
          if (!header) return null;
          const inner = header.firstElementChild;
          if (!inner) return null;
          const brand = inner.querySelector("a[href='/patients']");
          const nav = inner.querySelector('nav');
          const right = inner.lastElementChild;
          const pick = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          return { brand: pick(brand), nav: pick(nav), right: pick(right) };
        }"""
    )
    assert region_boxes is not None, f"{tag}: could not measure header regions"
    brand_box = region_boxes["brand"]
    nav_box = region_boxes["nav"]
    right_box = region_boxes["right"]

    for label, box in (
        ("brand", brand_box),
        ("nav", nav_box),
        ("right cluster", right_box),
    ):
        assert box is not None, f"{tag}: {label} region missing a bounding box"


    assert not rects_overlap(brand_box, nav_box), (
        f"{tag}: brand link overlaps nav (brand={brand_box}, nav={nav_box})"
    )
    assert not rects_overlap(nav_box, right_box), (
        f"{tag}: nav overlaps right-hand action cluster "
        f"(nav={nav_box}, right={right_box})"
    )
    assert not rects_overlap(brand_box, right_box), (
        f"{tag}: brand overlaps right-hand action cluster "
        f"(brand={brand_box}, right={right_box})"
    )

    # ---- 4. RIGHT CLUSTER OK ----
    # Every visible child of the right-hand cluster must stay fully within the
    # viewport and must not overlap any sibling. Sign out is always present;
    # the sync badge and user-name span are visibility-gated by breakpoint.
    sign_out = header.get_by_role("button", name="Sign out")
    assert_within_viewport(sign_out, "Sign out button", vp, tag)

    sibling_boxes = page.evaluate(
        """() => {
          const header = document.querySelector('header');
          if (!header) return [];
          const inner = header.firstElementChild;
          if (!inner) return [];
          const right = inner.lastElementChild;
          if (!right) return [];
          const out = [];
          for (const child of right.children) {
            const r = child.getBoundingClientRect();
            // Only measure visible children (display:none has 0x0 rect).
            if (r.width === 0 && r.height === 0) continue;
            out.push({
              tag: child.tagName + (child.getAttribute('aria-label')
                ? '[' + child.getAttribute('aria-label') + ']' : ''),
              x: r.x, y: r.y, width: r.width, height: r.height,
            });
          }
          return out;
        }"""
    )

    for i, a in enumerate(sibling_boxes):
        # Every visible sibling should be fully on-screen horizontally.
        assert a["x"] >= -1, (
            f"{tag}: right-cluster child {a['tag']} starts off-screen "
            f"(x={a['x']:.1f})"
        )
        assert a["x"] + a["width"] <= vp["width"] + 1, (
            f"{tag}: right-cluster child {a['tag']} overflows the viewport "
            f"(right={a['x'] + a['width']:.1f} > {vp['width']})"
        )
        for b in sibling_boxes[i + 1:]:
            assert not rects_overlap(a, b), (
                f"{tag}: right-cluster children overlap: {a['tag']} vs {b['tag']} "
                f"({a} vs {b})"
            )


def assert_within_viewport(locator, label, vp, tag):
    expect(locator, f"{tag}: {label} should be visible").to_be_visible(timeout=15000)
    box = locator.bounding_box()
    assert box is not None, f"{tag}: {label} has no bounding box"
    assert box["x"] >= -1, (
        f"{tag}: {label} starts off the left edge (x={box['x']:.1f})"
    )
    right = box["x"] + box["width"]
    assert right <= vp["width"] + 1, (
        f"{tag}: {label} overflows the right edge "
        f"(right={right:.1f} > {vp['width']})"
    )


def wait_for_authed_route(page, route):
    page.goto(f"{BASE_URL}{route}", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    assert "/auth" not in page.url, f"{route} redirected to /auth: {page.url}"
    # The header is rendered by the authenticated layout — wait for it before
    # any measurement so we don't race the first paint.
    expect(page.locator("header").first).to_be_visible(timeout=15000)


def main():
    user_id = None
    try:
        user_id, email = create_admin_user()
        session = sign_in(email)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            for vp in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": vp["width"], "height": vp["height"]}
                )
                page = context.new_page()

                page.goto(BASE_URL, wait_until="domcontentloaded")
                page.evaluate(
                    "([k, v]) => window.localStorage.setItem(k, v)",
                    [STORAGE_KEY, json.dumps(session)],
                )

                for route in ROUTES:
                    wait_for_authed_route(page, route)
                    check_header(page, vp, route)
                    page.screenshot(
                        path=str(
                            SCREENSHOTS
                            / f"header_{vp['name']}_{route.strip('/').replace('/', '_')}.png"
                        ),
                        clip={"x": 0, "y": 0, "width": vp["width"], "height": 80},
                    )

                context.close()

            browser.close()

        print(
            "PASS: header lays out cleanly at all breakpoints — no overflow, "
            "no wrapping, no overlaps between regions or right-cluster children"
        )
        return 0
    finally:
        cleanup(user_id)


if __name__ == "__main__":
    sys.exit(main())
