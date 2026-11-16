/**
 * Read a request body with a hard byte cap, checked BEFORE the body is
 * buffered: a declared Content-Length over the cap is refused without reading,
 * and an undeclared (streamed) body is cancelled as soon as it crosses the cap.
 * Decoding matches Request.text() (UTF-8, leading BOM removed), so HMAC
 * signatures computed over the text are unchanged.
 */
export type LimitedBody = { ok: true; text: string } | { ok: false };

export async function readBodyLimited(request: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) return { ok: false };
  }
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
}
