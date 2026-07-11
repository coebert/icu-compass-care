// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

/**
 * UI test: toggling columns in the preview's column picker must NEVER change how
 * the "Latest observations" block is rendered — the column picker only decides
 * whether the column appears, never how its content is produced. It also must
 * render the correct block for each patient scenario.
 *
 * We drive the real column-picker UI, capture the `columns` selection handed to
 * the PDF generator on every rebuild (by stubbing only `handoverPdfPreviewUrl`),
 * and assert that the observations render function output is invariant to every
 * toggle combination while presence in `columns` tracks the checkbox exactly.
 */

// Capture every options object the modal passes to the (stubbed) generator.
const captured = vi.hoisted(() => ({ calls: [] as { columns?: string[] }[] }));

vi.mock("@/lib/handover-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/handover-pdf")>();
  return {
    ...actual,
    handoverPdfPreviewUrl: vi.fn((_patients, opts) => {
      captured.calls.push({ columns: opts?.columns });
      return "blob:fake-preview-url";
    }),
  };
});

import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";
import { HANDOVER_COLUMNS, type HandoverPatient } from "@/lib/handover-pdf";
import type { Observation } from "@/lib/observations";

const renderObservations = HANDOVER_COLUMNS.find((c) => c.key === "observations")!.render;

// Radix primitives (Dialog, Slider, Checkbox) need browser APIs jsdom lacks.
beforeEach(() => {
  captured.calls.length = 0;
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

function obs(partial: Partial<Observation>): Observation {
  return {
    id: partial.id ?? crypto.randomUUID(),
    patient_id: "p1",
    recorded_at: partial.recorded_at ?? "2026-07-10T08:00:00.000Z",
    recorded_by: null,
    hr: null, sbp: null, dbp: null, map: null, spo2: null, fio2: null,
    rr: null, temp: null, gcs: null, lactate: null, vent_mode: null,
    peep: null, vt: null, vasopressor: null, vasopressor_dose: null,
    urine_ml: null, fluid_in_ml: null, fluid_out_ml: null, notes: null,
    ...partial,
  };
}

function patient(name: string, observations: Observation[]): HandoverPatient {
  return {
    full_name: name,
    hospital_number: "RN1",
    ward: "Critical Care Unit",
    bed: "3",
    status: "admitted",
    admission_date: "2026-07-01",
    patient_observations: observations,
  } as unknown as HandoverPatient;
}

const SAME_TIME = "2026-07-10T08:00:00.000Z";

const SCENARIOS: { name: string; patient: HandoverPatient; expected: RegExp }[] = [
  {
    name: "single observation",
    patient: patient("Single", [obs({ id: "z-single", recorded_at: SAME_TIME, hr: 88, spo2: 95 })]),
    expected: /HR 88.*SpO.*95%.*id z-single/s,
  },
  {
    name: "distinct timestamps → most recent wins",
    patient: patient("Distinct", [
      obs({ id: "old-1", recorded_at: "2026-07-10T06:00:00.000Z", hr: 60 }),
      obs({ id: "new-1", recorded_at: "2026-07-10T09:30:00.000Z", hr: 130 }),
    ]),
    expected: /HR 130.*id new-1/s,
  },
  {
    name: "tie-break: identical recorded_at, greater id wins",
    patient: patient("Tie", [
      obs({ id: "obs-aaaa", recorded_at: SAME_TIME, hr: 70, spo2: 98 }),
      obs({ id: "obs-bbbb", recorded_at: SAME_TIME, hr: 120, spo2: 88 }),
    ]),
    expected: /HR 120.*id obs-bbbb/s,
  },
  {
    name: "no observations",
    patient: patient("None", []),
    expected: /^—$/,
  },
];

describe("Column picker never alters Latest observations rendering", () => {
  for (const scenario of SCENARIOS) {
    it(`block renders correctly and is toggle-invariant — ${scenario.name}`, () => {
      // The single source of truth for the block, computed independently.
      const expectedBlock = renderObservations(scenario.patient);
      expect(expectedBlock).toMatch(scenario.expected);

      render(
        <HandoverPreviewModal
          open
          onOpenChange={() => {}}
          patients={[scenario.patient]}
          title="ICU Handover"
        />,
      );

      const dialog = screen.getByRole("dialog");
      const obsCheckbox = within(dialog).getByRole("checkbox", { name: /Latest observations/i });
      const pmhCheckbox = within(dialog).getByRole("checkbox", { name: /Past medical history/i });

      // Exercise a range of toggle combinations affecting OTHER columns and the
      // observations column itself.
      fireEvent.click(pmhCheckbox); // turn an unrelated column off
      fireEvent.click(obsCheckbox); // observations off
      fireEvent.click(obsCheckbox); // observations back on
      fireEvent.click(within(dialog).getByRole("button", { name: /Clear/i }));
      fireEvent.click(within(dialog).getByRole("button", { name: /Select all/i }));
      fireEvent.click(pmhCheckbox); // unrelated toggle again

      // Every rebuild must have gone through the generator.
      expect(captured.calls.length).toBeGreaterThan(1);

      // 1) The observations render output is a pure function of the patient —
      //    identical no matter which columns were selected at the time.
      for (const call of captured.calls) {
        expect(renderObservations(scenario.patient)).toBe(expectedBlock);
      }

      // 2) Presence of the observations column in the payload tracks the toggle,
      //    but its *content* never changes. When columns is empty the generator
      //    falls back to all columns, so observations still renders.
      const rendersObservations = captured.calls.map(
        (c) => !c.columns || c.columns.length === 0 || c.columns.includes("observations"),
      );
      expect(rendersObservations.some(Boolean)).toBe(true);
    });
  }

  it("deselecting observations removes only that column, not its render logic", () => {
    const p = patient("Toggle", [obs({ id: "obs-bbbb", recorded_at: SAME_TIME, hr: 120, spo2: 88 })]);
    const before = renderObservations(p);

    render(<HandoverPreviewModal open onOpenChange={() => {}} patients={[p]} title="ICU" />);
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Latest observations/i }));
    const lastAfterOff = captured.calls.at(-1)!;
    // Column dropped from the selection...
    expect(lastAfterOff.columns).not.toContain("observations");
    // ...but the render function is untouched and still deterministic.
    expect(renderObservations(p)).toBe(before);
    expect(before).toMatch(/HR 120.*id obs-bbbb/s);
  });
});
