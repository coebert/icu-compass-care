import { describe, expect, it } from "vitest";
import { FRAME_ANCESTORS, SECURITY_HEADERS, applySecurityHeaders } from "@/lib/security-headers";

describe("anti-framing policy", () => {
  it("allows only self and the exact Lovable editor origins (no wildcards)", () => {
    expect(FRAME_ANCESTORS).toEqual(["'self'", "https://lovable.dev", "https://www.lovable.dev"]);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toMatch(/\*/);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toMatch(
      /lovable\.app|lovableproject\.com/,
    );
  });
  it("is applied to responses without overriding explicit headers", () => {
    const h = new Headers({ "Referrer-Policy": "no-referrer" });
    applySecurityHeaders(h);
    expect(h.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' https://lovable.dev https://www.lovable.dev",
    );
    expect(h.get("Referrer-Policy")).toBe("no-referrer");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
