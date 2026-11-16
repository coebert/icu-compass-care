import { describe, expect, it } from "vitest";
import { decideActivity } from "@/hooks/use-inactivity-timeout";

const MIN = 60_000;
const TIMEOUT = 15 * MIN; // same as the server idle limit
const PING = 1 * MIN;
const WARN = 1 * MIN;

describe("idle clock follows the server heartbeat", () => {
  it("activity within a minute of the last heartbeat does not move the clock", () => {
    // Heartbeat at 0, active until 59s: the deadline stays at 15:00, same as the server.
    expect(decideActivity(59_000, 0, TIMEOUT, PING)).toBe("skip");
  });

  it("activity a minute or more after the last heartbeat sends a new one", () => {
    expect(decideActivity(PING, 0, TIMEOUT, PING)).toBe("record");
  });

  it("any activity during the warning minute sends a heartbeat before the server limit", () => {
    const warningStart = TIMEOUT - WARN; // 14:00 after the last heartbeat
    expect(decideActivity(warningStart, 0, TIMEOUT, PING)).toBe("record");
    expect(decideActivity(TIMEOUT - 1_000, 0, TIMEOUT, PING)).toBe("record");
  });

  it("activity at or after 15 minutes does not revive the session", () => {
    expect(decideActivity(TIMEOUT, 0, TIMEOUT, PING)).toBe("expired");
    expect(decideActivity(TIMEOUT + 5_000, 0, TIMEOUT, PING)).toBe("expired");
  });
});
