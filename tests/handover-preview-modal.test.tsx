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

// The Download button calls a server function that re-validates every patient
// record before the PDF is produced; in jsdom there is no server, so the
// validator is stubbed to resolve.
vi.mock("@/lib/handover.functions", () => ({
  validateHandoverExport: Object.assign(vi.fn(async () => ({ ok: true })), {
    url: "/_serverFn/validateHandoverExport",
  }),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useServerFn: () => vi.fn(async () => ({ ok: true })) };
});

vi.mock("@/lib/handover-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/handover-pdf")>();
  return {
    ...actual,
    handoverPdfPreviewUrl: vi.fn(() => "blob:fake-preview-url"),
  };
});

const PATIENTS: HandoverPatient[] = [
  { id: "11111111-1111-4111-8111-111111111111", initials: "A.B.", status: "admitted", admission_date: new Date().toISOString() },
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
  vi.restoreAllMocks();
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
  it("shows the exact filename that the Download button saves", async () => {
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
    await vi.waitFor(() => expect(capture.get()).not.toBeNull());

    const downloaded = capture.get();
    expect(downloaded, "download should have fired").not.toBeNull();
    expect(downloaded).toBe(displayed);
  });

  it("keeps display and download in sync for a custom header title", async () => {
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
    await vi.waitFor(() => expect(capture.get()).not.toBeNull());

    expect(capture.get()).toBe(displayed);
    // Sanitized: no path separators or header-breaking characters survive.
    expect(displayed).not.toMatch(/[/:"]/);
    expect(displayed.endsWith(".pdf")).toBe(true);
  });

  it("revokes the download object URL after clicking Download PDF (no memory leak)", async () => {
    vi.useFakeTimers();
    captureDownloadFilename();

    // Hand out a unique object URL for the download and record it, so we can
    // assert the very same URL is later revoked.
    let created: string | null = null;
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => {
        created = `blob:download-${Math.random().toString(36).slice(2)}`;
        return created;
      });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      render(
        <HandoverPreviewModal open onOpenChange={() => {}} patients={PATIENTS} title="ICU Handover Sheet" />,
      );

      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /Download PDF/i }));
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(0);
        expect(createSpy).toHaveBeenCalled();
      });

      // A fresh object URL was created for the download.
      expect(createSpy).toHaveBeenCalled();
      expect(created).not.toBeNull();

      // Revocation is scheduled on the next tick to let the browser grab the
      // blob; nothing is leaked once the timer fires.
      vi.runAllTimers();

      expect(revokeSpy).toHaveBeenCalledWith(created);
    } finally {
      vi.useRealTimers();
    }
  });
});

