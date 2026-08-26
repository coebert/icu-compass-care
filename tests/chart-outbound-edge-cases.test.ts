/**
 * Edge-case coverage for the outbound image guard.
 *
 * Verifies metadata stripping and identifier scrubbing behave consistently for
 * awkward real-world files: corrupted EXIF blocks, unusual chunk layouts,
 * oversized metadata, trailing data, and malformed containers.
 */
import { describe, expect, it } from "vitest";
import {
  OutboundGuardError,
  sanitiseOutboundImage,
} from "@/lib/chart-outbound.server";

const ID = {
  name: "SMITH John",
  mrn: "RXK1234567",
  nhs: "943 476 5919",
  dob: "1948-03-04",
  address: "12 Wilton Road, Salisbury SP2 7AB",
};
const TOKENS = Object.values(ID);

function u8(...parts: Array<number[] | Uint8Array | string>): Uint8Array {
  const chunks = parts.map((p) =>
    typeof p === "string"
      ? new TextEncoder().encode(p)
      : p instanceof Uint8Array
        ? p
        : new Uint8Array(p),
  );
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

function payloadText(dataUrl: string): string {
  return atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
}

function expectNoIdentifiers(dataUrl: string, label: string) {
  const raw = payloadText(dataUrl);
  for (const token of TOKENS) {
    expect(raw.includes(token), `${label} leaked ${token}`).toBe(false);
  }
}

// ---------------------------------------------------------------- JPEG helpers

function jpegSeg(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return u8([0xff, marker, (len >> 8) & 0xff, len & 0xff], payload);
}
const JPEG_DQT = jpegSeg(0xdb, new Uint8Array(64).fill(0x10));
const JPEG_SCAN = u8([0xff, 0xda], new Uint8Array(64).fill(0x5a), [0xff, 0xd9]);

// ----------------------------------------------------------------- PNG helpers

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  return u8(
    [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff],
    type,
    payload,
    [0, 0, 0, 0], // CRC placeholder — the guard does not verify CRCs
  );
}
const PNG_IHDR = pngChunk(
  "IHDR",
  u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
);
const PNG_IDAT = pngChunk("IDAT", new Uint8Array(16).fill(0x33));
const PNG_IEND = pngChunk("IEND", new Uint8Array(0));

// ---------------------------------------------------------------- WebP helpers

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const pad = len % 2 ? [0] : [];
  return u8(
    type,
    [len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff],
    payload,
    pad,
  );
}
function webpFile(...chunks: Uint8Array[]): Uint8Array {
  const body = u8(...chunks);
  const size = 4 + body.length;
  return u8(
    "RIFF",
    [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff],
    "WEBP",
    body,
  );
}
const WEBP_VP8 = webpChunk("VP8 ", new Uint8Array(40).fill(0x2a));

describe("outbound guard: JPEG edge cases", () => {
  it("strips a corrupted/truncated EXIF block without trusting its contents", () => {
    // Valid segment length, but the TIFF header inside is garbage and the
    // identifier text sits after the corruption.
    const brokenExif = u8(
      "Exif\0\0",
      [0x4d, 0x4d, 0xff, 0xff, 0x00, 0x00, 0x00, 0x63],
      new Uint8Array(9).fill(0xff),
      `${ID.name} ${ID.mrn} ${ID.dob}`,
    );
    const bytes = u8([0xff, 0xd8], jpegSeg(0xe1, brokenExif), JPEG_DQT, JPEG_SCAN);
    const safe = sanitiseOutboundImage(toDataUrl("image/jpeg", bytes));
    expect(safe.strippedSegments).toContain("JPEG:APP1");
    expectNoIdentifiers(safe.dataUrl, "corrupt EXIF");
  });

  it("handles fill bytes, unusual marker order and every APPn slot", () => {
    const apps = Array.from({ length: 16 }, (_, n) =>
      jpegSeg(0xe0 + n, u8(`APP${n}: ${ID.name} ${ID.mrn} ${ID.nhs} ${ID.address}`)),
    );
    const bytes = u8(
      [0xff, 0xd8],
      apps[0]!,
      [0xff, 0xff, 0xff], // fill bytes before the next marker
      ...apps.slice(1),
      jpegSeg(0xfe, u8(`COM ${ID.address}`)),
      JPEG_DQT,
      jpegSeg(0xfe, u8(`late COM ${ID.name}`)),
      JPEG_SCAN,
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/jpeg", bytes));
    for (let n = 0; n < 16; n += 1) {
      expect(safe.strippedSegments).toContain(`JPEG:APP${n}`);
    }
    expect(safe.strippedSegments.filter((s) => s === "JPEG:COM")).toHaveLength(2);
    expectNoIdentifiers(safe.dataUrl, "many APPn");
  });

  it("strips oversized metadata segments and shrinks the payload", () => {
    const big = u8(
      "Exif\0\0",
      `${ID.name} ${ID.mrn} `.repeat(2000).slice(0, 65000),
    );
    const bytes = u8(
      [0xff, 0xd8],
      jpegSeg(0xe1, big.subarray(0, 65525)),
      jpegSeg(0xe1, big.subarray(0, 65525)),
      jpegSeg(0xe1, big.subarray(0, 65525)),
      JPEG_DQT,
      JPEG_SCAN,
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/jpeg", bytes));
    expect(safe.strippedSegments.filter((s) => s === "JPEG:APP1")).toHaveLength(3);
    expect(payloadText(safe.dataUrl).length).toBeLessThan(400);
    expectNoIdentifiers(safe.dataUrl, "oversized EXIF");
  });

  it("discards anything appended after the end-of-image marker", () => {
    const bytes = u8(
      [0xff, 0xd8],
      JPEG_DQT,
      JPEG_SCAN,
      `TRAILER ${ID.name} ${ID.mrn} ${ID.nhs}`,
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/jpeg", bytes));
    expect(safe.strippedSegments).toContain("JPEG:TRAILER");
    expectNoIdentifiers(safe.dataUrl, "JPEG trailer");
  });

  it("rejects malformed JPEG structures instead of forwarding them", () => {
    const cases: Array<[string, Uint8Array]> = [
      ["no SOI", u8("JFIF", new Uint8Array(64).fill(1))],
      ["junk where a marker should be", u8([0xff, 0xd8], `${ID.name} ${ID.mrn}`, new Uint8Array(40).fill(9))],
      ["segment length < 2", u8([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01], `${ID.mrn}`, new Uint8Array(40).fill(3))],
      ["segment length past EOF", u8([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff], `${ID.mrn}`, new Uint8Array(40).fill(3))],
    ];
    for (const [label, bytes] of cases) {
      expect(() => sanitiseOutboundImage(toDataUrl("image/jpeg", bytes)), label).toThrow(
        OutboundGuardError,
      );
    }
  });

  it("is idempotent — re-sanitising a clean JPEG strips nothing more", () => {
    const bytes = u8([0xff, 0xd8], jpegSeg(0xe1, u8("Exif\0\0", ID.mrn)), JPEG_DQT, JPEG_SCAN);
    const once = sanitiseOutboundImage(toDataUrl("image/jpeg", bytes));
    const twice = sanitiseOutboundImage(once.dataUrl);
    expect(twice.strippedSegments).toEqual([]);
    expect(twice.dataUrl).toBe(once.dataUrl);
  });
});

describe("outbound guard: PNG edge cases", () => {
  it("drops text/metadata chunks in unusual layouts", () => {
    const bytes = u8(
      PNG_SIG,
      pngChunk("tEXt", u8(`Title\0${ID.name} ${ID.mrn}`)),
      PNG_IHDR,
      pngChunk("iTXt", u8(`Description\0\0\0\0${ID.address}`)),
      pngChunk("eXIf", u8(`II*\0${ID.dob}`)),
      PNG_IDAT,
      pngChunk("zTXt", u8(`Comment\0\0${ID.nhs}`)),
      PNG_IDAT,
      pngChunk("tIME", u8([0x07, 0xea, 1, 1, 0, 0, 0])),
      pngChunk("prVt", u8(`${ID.name}`)),
      PNG_IEND,
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/png", bytes));
    for (const type of ["PNG:tEXt", "PNG:iTXt", "PNG:eXIf", "PNG:zTXt", "PNG:tIME", "PNG:prVt"]) {
      expect(safe.strippedSegments).toContain(type);
    }
    expect(safe.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expectNoIdentifiers(safe.dataUrl, "PNG chunks");
  });

  it("drops chunks appended after IEND", () => {
    const bytes = u8(
      PNG_SIG,
      PNG_IHDR,
      PNG_IDAT,
      PNG_IEND,
      pngChunk("tEXt", u8(`After\0${ID.name} ${ID.mrn}`)),
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/png", bytes));
    expectNoIdentifiers(safe.dataUrl, "post-IEND chunk");
  });

  it("strips oversized text chunks", () => {
    const huge = u8(`Bulk\0${`${ID.name} ${ID.mrn} `.repeat(9000)}`);
    const bytes = u8(PNG_SIG, PNG_IHDR, pngChunk("tEXt", huge), PNG_IDAT, PNG_IEND);
    expect(huge.length).toBeGreaterThan(150_000);
    const safe = sanitiseOutboundImage(toDataUrl("image/png", bytes));
    expect(safe.strippedSegments).toContain("PNG:tEXt");
    expect(payloadText(safe.dataUrl).length).toBeLessThan(200);
    expectNoIdentifiers(safe.dataUrl, "oversized PNG text");
  });

  it("rejects bad signatures and truncated chunk lengths", () => {
    const badSig = u8("PNG-ish?", PNG_IHDR, PNG_IDAT, PNG_IEND);
    const truncated = u8(PNG_SIG, PNG_IHDR, u8([0x00, 0x0f, 0xff, 0xff], "tEXt", ID.mrn));
    for (const [label, bytes] of [
      ["bad signature", badSig],
      ["chunk length past EOF", truncated],
    ] as const) {
      expect(() => sanitiseOutboundImage(toDataUrl("image/png", bytes)), label).toThrow(
        OutboundGuardError,
      );
    }
  });
});

describe("outbound guard: WebP edge cases", () => {
  it("drops EXIF/XMP chunks regardless of position and keeps the file valid", () => {
    const bytes = webpFile(
      webpChunk("XMP ", u8(`<dc:creator>${ID.name}</dc:creator>`)),
      WEBP_VP8,
      webpChunk("EXIF", u8(`II*\0${ID.mrn} ${ID.nhs}`)),
    );
    const safe = sanitiseOutboundImage(toDataUrl("image/webp", bytes));
    expect(safe.strippedSegments).toEqual(
      expect.arrayContaining(["WEBP:XMP ", "WEBP:EXIF"]),
    );
    expectNoIdentifiers(safe.dataUrl, "WebP metadata");

    // RIFF size field is rewritten to match the shortened body.
    const raw = payloadText(safe.dataUrl);
    const size =
      raw.charCodeAt(4) |
      (raw.charCodeAt(5) << 8) |
      (raw.charCodeAt(6) << 16) |
      (raw.charCodeAt(7) << 24);
    expect(size).toBe(raw.length - 8);
    expect(raw.slice(0, 4)).toBe("RIFF");
    expect(raw.slice(8, 12)).toBe("WEBP");
  });

  it("handles odd-length (word-padded) metadata chunks", () => {
    const odd = u8(`${ID.mrn}!`); // force an odd payload length
    expect(odd.length % 2).toBe(1);
    const bytes = webpFile(webpChunk("EXIF", odd), WEBP_VP8);
    const safe = sanitiseOutboundImage(toDataUrl("image/webp", bytes));
    expect(safe.strippedSegments).toContain("WEBP:EXIF");
    expectNoIdentifiers(safe.dataUrl, "odd-length WebP chunk");
  });

  it("strips oversized WebP metadata", () => {
    const big = u8(`${ID.name} ${ID.mrn} `.repeat(6000));
    const bytes = webpFile(webpChunk("XMP ", big), WEBP_VP8);
    const safe = sanitiseOutboundImage(toDataUrl("image/webp", bytes));
    expect(big.length).toBeGreaterThan(100_000);
    expect(payloadText(safe.dataUrl).length).toBeLessThan(200);
    expectNoIdentifiers(safe.dataUrl, "oversized WebP metadata");
  });

  it("rejects non-RIFF/non-WEBP containers and truncated chunks", () => {
    const notRiff = u8("RIFX", [0, 0, 0, 32], "WEBP", WEBP_VP8);
    const notWebp = u8("RIFF", [40, 0, 0, 0], "AVI ", WEBP_VP8);
    const truncated = u8("RIFF", [60, 0, 0, 0], "WEBP", "EXIF", [0xff, 0xff, 0, 0], ID.mrn);
    for (const [label, bytes] of [
      ["not RIFF", notRiff],
      ["not WEBP", notWebp],
      ["truncated chunk", truncated],
    ] as const) {
      expect(() => sanitiseOutboundImage(toDataUrl("image/webp", bytes)), label).toThrow(
        OutboundGuardError,
      );
    }
  });
});
