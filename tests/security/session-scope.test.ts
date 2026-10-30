import { describe, expect, it } from "vitest";
import { scopeTransition } from "@/lib/session-lock";

describe("auth session change handling (reauth creates a new session)", () => {
  it("a different session id after reauth is treated as a new session (reset lock, deadline, cache)", () => {
    expect(scopeTransition("old-session", "SIGNED_IN", "new-session")).toBe("new_session");
    expect(scopeTransition("old-session", "TOKEN_REFRESHED", "new-session")).toBe("new_session");
  });
  it("a token refresh on the same session keeps the existing deadline", () => {
    expect(scopeTransition("s1", "TOKEN_REFRESHED", "s1")).toBe("none");
  });
  it("first session observed initialises scope without a reset", () => {
    expect(scopeTransition(null, "INITIAL_SESSION", "s1")).toBe("init");
  });
  it("sign-out clears scope", () => {
    expect(scopeTransition("s1", "SIGNED_OUT", null)).toBe("signed_out");
    expect(scopeTransition("s1", "USER_UPDATED", null)).toBe("signed_out");
    expect(scopeTransition(null, "SIGNED_OUT", null)).toBe("none");
  });
});
