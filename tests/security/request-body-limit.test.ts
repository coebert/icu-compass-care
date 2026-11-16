import { describe, it, expect } from "vitest";
import { readBodyLimited } from "@/lib/request-body.server";

function streamed(chunks: Uint8Array[], pulled: { n: number }) {
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const c = chunks[pulled.n++];
      if (c) ctrl.enqueue(c);
      else ctrl.close();
    },
  }, { highWaterMark: 0 });
}

describe("readBodyLimited", () => {
  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const pulled = { n: 0 };
    const req = new Request("http://isolated.test/x", {
      method: "POST",
      headers: { "content-length": String(3 * 1024 * 1024) },
      body: streamed([new Uint8Array(10)], pulled),
      // @ts-expect-error Node fetch needs duplex for stream bodies
      duplex: "half",
    });
    expect(await readBodyLimited(req, 2 * 1024 * 1024)).toEqual({ ok: false });
    expect(pulled.n).toBe(0);
  });

  it("refuses a malformed Content-Length", async () => {
    const req = new Request("http://isolated.test/x", { method: "POST", body: "{}", headers: { "content-length": "abc" } });
    expect(await readBodyLimited(req, 1024)).toEqual({ ok: false });
  });

  it("stops reading a streamed body as soon as it passes the cap", async () => {
    const pulled = { n: 0 };
    const chunk = new Uint8Array(1024);
    const req = new Request("http://isolated.test/x", {
      method: "POST",
      body: streamed(Array.from({ length: 100 }, () => chunk), pulled),
      // @ts-expect-error Node fetch needs duplex for stream bodies
      duplex: "half",
    });
    expect(await readBodyLimited(req, 4 * 1024)).toEqual({ ok: false });
    expect(pulled.n).toBeLessThan(10);
  });

  it("accepts a body exactly at the cap", async () => {
    const body = "a".repeat(2048);
    const req = new Request("http://isolated.test/x", { method: "POST", body });
    expect(await readBodyLimited(req, 2048)).toEqual({ ok: true, text: body });
  });

  it("decodes exactly like Request.text() so signatures are unchanged", async () => {
    const body = "\uFEFF{\"n\":\"Zoë – 24h ✓ 🫀\"}";
    const a = new Request("http://isolated.test/x", { method: "POST", body });
    const b = new Request("http://isolated.test/x", { method: "POST", body });
    const limited = await readBodyLimited(a, 1024);
    expect(limited).toEqual({ ok: true, text: await b.text() });
  });

  it("returns an empty string when there is no body", async () => {
    expect(await readBodyLimited(new Request("http://isolated.test/x", { method: "POST" }), 10)).toEqual({ ok: true, text: "" });
  });
});
