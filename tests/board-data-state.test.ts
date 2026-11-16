import { describe, it, expect } from "vitest";
import {
  availabilityConfirmed,
  emptyKind,
  queryDataState,
  splitOccupancy,
} from "@/lib/board-data-state";

describe("patient board data state", () => {
  it("initial load failure is 'failed', never an empty board", () => {
    expect(
      queryDataState({ data: undefined, isPending: false, isError: true, dataUpdatedAt: 0 }),
    ).toEqual({ kind: "failed" });
  });
  it("refresh failure keeps same-session data as stale with its age", () => {
    expect(
      queryDataState({ data: [], isPending: false, isError: true, dataUpdatedAt: 1000 }),
    ).toEqual({
      kind: "stale",
      lastGoodAt: 1000,
    });
  });
  it("availability is confirmed only when every input is fresh", () => {
    const ready = { kind: "ready", lastGoodAt: 1 } as const;
    expect(availabilityConfirmed(ready, ready)).toBe(true);
    expect(availabilityConfirmed(ready, { kind: "stale", lastGoodAt: 1 })).toBe(false);
    expect(availabilityConfirmed(ready, { kind: "loading" })).toBe(false);
  });
  it("separates confirmed empty from filtered-to-nothing", () => {
    expect(emptyKind({ inView: 0, visible: 0 })).toBe("confirmed_empty");
    expect(emptyKind({ inView: 3, visible: 0 })).toBe("filtered_empty");
    expect(emptyKind({ inView: 3, visible: 1 })).toBe("has_results");
  });
  it("a bed whose patient is filtered out stays occupied (hidden), never empty", () => {
    const patients = [
      { id: "a", bed: "1" },
      { id: "b", bed: " 2 " },
      { id: "c", bed: null },
    ];
    const o = splitOccupancy(patients, new Set(["a", "c"]), ["1", "2", "3"]);
    expect([...o.allByBed.keys()].sort()).toEqual(["1", "2"]);
    expect([...o.visibleByBed.keys()]).toEqual(["1"]);
    expect([...o.hiddenBeds]).toEqual(["2"]);
    expect(o.unassignedVisible.map((p) => p.id)).toEqual(["c"]);
  });
});
