// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";
import type { HandoverPatient } from "@/lib/handover-pdf";

/**
 * UI test: the filename shown in the preview modal ("Download: <name>") must be
 * byte-for-byte identical to the filename the browser actually saves when the
 * "Download PDF" button is clicked.
 *
 * The real `formatHandoverFilename` / `downloadHandoverFromUrl` are exercised —
 * only `handoverPdfPreviewUrl` is stubbed so we don't build a real PDF blob
 * (jsdom has no PDF/canvas pipeline) and the Download button becomes enabled.
 *
 * A timestamp-free filename format is used so the value cannot legitimately
 * differ between render time and click time.
 */

vi.mock("@/lib/handover-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/handover-pdf")>();
  return {
    ...actual,
    handoverPdfPreviewUrl: vi.fn(() => "blob:fake-preview-url"),
  };
});

const PATIENTS: HandoverPatient[] = [
  { full_name: "A.B.", status: "admitted", admission_date: new Date().toISOString() },
];

// Radix primitives (Dialog, Slider) need these browser APIs that jsdom lacks.
beforeEach(() => {
  // @ts-expect-error jsdom stub
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= (() =>
    ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  if (!("createObjectURL" in URL)) {
    // @ts-expect-error jsdom stub
    URL.createObjectURL = () => "blob:fake";
  }
  // @ts-expect-error jsdom stub
  URL.revokeObjectURL ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Capture the `download` attribute of the anchor the download helper clicks. */
function captureDownloadFilename(): { get: () => string | null } {
  const state = { value: null as string | null };
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: unknown[]) => {
    const el = realCreate(tag as never, ...(rest as []));
    if (tag.toLowerCase() === "a") {
      el.click = () => {
        state.value = (el as HTMLAnchorElement).download;
      };
    }
    return el;
  });
  return { get: () => state.value };
}

function readDisplayedFilename(): string {
  const line = screen.getByText(/^Download:/);
  return (line.textContent ?? "").replace(/^Download:\s*/, "");
}

describe("HandoverPreviewModal download filename", () => {
  it("shows the exact filename that the Download button saves", () => {
    const capture = captureDownloadFilename();

    render(
      <HandoverPreviewModal
        open
        onOpenChange={() => {}}
        patients={PATIENTS}
        title="Night ICU Handover"
      />,
    );

    // Use a timestamp-free format so the displayed and downloaded names can't
    // differ by clock drift between render and click.
    const filenameInput = screen.getByLabelText(/Filename format/i);
    fireEvent.change(filenameInput, { target: { value: "{title}_{date}.pdf" } });

    const displayed = readDisplayedFilename();
    expect(displayed).toMatch(/\.pdf$/);
    expect(displayed).toContain("Night_ICU_Handover");

    // Click the actual Download button and read the anchor's download attr.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Download PDF/i }));

    const downloaded = capture.get();
    expect(downloaded, "download should have fired").not.toBeNull();
    expect(downloaded).toBe(displayed);
  });

  it("keeps display and download in sync for a custom header title", () => {
    const capture = captureDownloadFilename();

    render(
      <HandoverPreviewModal open onOpenChange={() => {}} patients={PATIENTS} title="ICU Handover Sheet" />,
    );

    const filenameInput = screen.getByLabelText(/Filename format/i);
    fireEvent.change(filenameInput, { target: { value: "{title}.pdf" } });

    const titleInput = screen.getByLabelText(/Header title/i);
    fireEvent.change(titleInput, { target: { value: "Weekend / Twilight: Handover" } });

    const displayed = readDisplayedFilename();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Download PDF/i }));

    expect(capture.get()).toBe(displayed);
    // Sanitized: no path separators or header-breaking characters survive.
    expect(displayed).not.toMatch(/[/:"]/);
    expect(displayed.endsWith(".pdf")).toBe(true);
  });
});
