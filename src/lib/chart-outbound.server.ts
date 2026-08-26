/**
 * Outbound guard for chart-scan images.
 *
 * Everything sent to the vision model passes through here first. The client is
 * already required to blur the identity sticker before upload, but the client is
 * not a trust boundary: a modified or stale client, a replayed request, or a
 * hand-crafted call to the RPC endpoint could still put an identifier on the
 * wire. This module rebuilds the outbound payload from scratch so only the
 * pixels of a plain raster image can leave the server:
 *
 *  - the data URL header is re-emitted canonically, dropping every parameter
 *    (a `data:image/jpeg;name=SMITH_John_NHS123.jpg;base64,...` filename is a
 *    direct identifier leak),
 *  - only JPEG/PNG/WebP are allowed through,
 *  - JPEG EXIF/XMP/IPTC/comment segments and PNG/WebP text + metadata chunks
 *    are stripped, so device IDs, GPS, author names, captions and scanner
 *    software fields never reach the model,
 *  - the base64 body is validated and re-encoded from the parsed bytes.
 *
 * Pure functions, no I/O, no logging of image bytes.
 */

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export type OutboundImage = {
  /** Canonical `data:<mime>;base64,<payload>` safe to send upstream. */
  dataUrl: string;
  mime: string;
  /** Metadata segments/chunks removed while sanitising. */
  strippedSegments: string[];
};

export class OutboundGuardError extends Error {}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** JPEG: keep only SOI, frame/scan and quantisation/Huffman data. */
function stripJpegMetadata(bytes: Uint8Array): { bytes: Uint8Array; stripped: string[] } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new OutboundGuardError("Page is not a valid JPEG image.");
  }
  const stripped: string[] = [];
  const keep: Array<[number, number]> = [[0, 2]]; // SOI
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      throw new OutboundGuardError("Malformed JPEG structure; page rejected.");
    }
    let marker = bytes[i + 1]!;
    // Fill bytes.
    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1;
      marker = bytes[i + 1]!;
    }
    if (marker === 0xd9) {
      keep.push([i, bytes.length]);
      break;
    }
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded image data, keep verbatim.
      keep.push([i, bytes.length]);
      break;
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2) throw new OutboundGuardError("Malformed JPEG segment; page rejected.");
    const end = i + 2 + len;
    if (end > bytes.length) throw new OutboundGuardError("Truncated JPEG segment; page rejected.");
    // APP0..APP15 (EXIF, XMP, IPTC, Adobe, scanner tags) and COM comments go.
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isApp || isComment) {
      stripped.push(isComment ? "JPEG:COM" : `JPEG:APP${marker - 0xe0}`);
    } else {
      keep.push([i, end]);
    }
    i = end;
  }

  const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), off);
    off += b - a;
  }
  return { bytes: out, stripped };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG: drop every ancillary metadata chunk, keep the critical image chunks. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "sRGB", "cHRM", "iCCP", "sBIT", "pHYs"]);

function stripPngMetadata(bytes: Uint8Array): { bytes: Uint8Array; stripped: string[] } {
  for (let i = 0; i < PNG_SIG.length; i += 1) {
    if (bytes[i] !== PNG_SIG[i]) throw new OutboundGuardError("Page is not a valid PNG image.");
  }
  const stripped: string[] = [];
  const keep: Array<[number, number]> = [[0, 8]];
  let i = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i + 8 <= bytes.length) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const end = i + 12 + len;
    if (end > bytes.length) throw new OutboundGuardError("Truncated PNG chunk; page rejected.");
    if (PNG_KEEP.has(type)) {
      keep.push([i, end]);
    } else {
      stripped.push(`PNG:${type}`);
    }
    i = end;
    if (type === "IEND") break;
  }
  const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), off);
    off += b - a;
  }
  return { bytes: out, stripped };
}

/**
 * WebP: RIFF container. Drop EXIF/XMP chunks; keep the image payload chunks and
 * rewrite the RIFF size so the result stays a valid file.
 */
const WEBP_DROP = new Set(["EXIF", "XMP "]);
function stripWebpMetadata(bytes: Uint8Array): { bytes: Uint8Array; stripped: string[] } {
  const tag = (o: number) =>
    String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") {
    throw new OutboundGuardError("Page is not a valid WebP image.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stripped: string[] = [];
  const keep: Array<[number, number]> = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = tag(i);
    const len = view.getUint32(i + 4, true);
    const end = i + 8 + len + (len % 2); // chunks are word-aligned
    if (end > bytes.length + 1) throw new OutboundGuardError("Truncated WebP chunk; page rejected.");
    if (WEBP_DROP.has(type)) {
      stripped.push(`WEBP:${type}`);
    } else {
      keep.push([i, Math.min(end, bytes.length)]);
    }
    i = end;
  }
  const body = keep.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes.subarray(0, 12), 0);
  let off = 12;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), off);
    off += b - a;
  }
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { bytes: out, stripped };
}

/**
 * Rebuild one page as a metadata-free, canonically-headed data URL.
 * Throws OutboundGuardError if the page is not a plain supported raster image.
 */
export function sanitiseOutboundImage(dataUrl: string): OutboundImage {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) {
    throw new OutboundGuardError("Page is not a valid image upload.");
  }
  const header = dataUrl.slice(5, comma);
  const params = header.split(";").map((p) => p.trim());
  const mime = (params.shift() ?? "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new OutboundGuardError(
      "Only JPEG, PNG or WebP chart photographs can be processed.",
    );
  }
  if (!params.some((p) => p.toLowerCase() === "base64")) {
    throw new OutboundGuardError("Chart pages must be base64-encoded.");
  }
  // Any other header parameter (name=, filename=, charset=, description=) is
  // dropped rather than trusted — it is a free-text channel for identifiers.
  const strippedSegments = params
    .filter((p) => p.toLowerCase() !== "base64" && p.length > 0)
    .map((p) => `DATAURL:${p.split("=")[0]}`);

  const b64 = dataUrl.slice(comma + 1).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new OutboundGuardError("Chart page payload is not valid base64.");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(b64);
  } catch {
    throw new OutboundGuardError("Chart page payload could not be decoded.");
  }
  if (bytes.length < 32) throw new OutboundGuardError("Chart page is too small to be an image.");

  const result =
    mime === "image/jpeg"
      ? stripJpegMetadata(bytes)
      : mime === "image/png"
        ? stripPngMetadata(bytes)
        : stripWebpMetadata(bytes);

  return {
    dataUrl: `data:${mime};base64,${encodeBase64(result.bytes)}`,
    mime,
    strippedSegments: [...strippedSegments, ...result.stripped],
  };
}
