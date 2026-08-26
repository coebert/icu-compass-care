import { describe, it, expect } from "vitest";
import {
  CHART_SYSTEM_PROMPT,
  buildChartExtractionMessages,
  scrubExtractionIdentifiers,
} from "@/lib/chart-prompt.server";
import { sanitiseOutboundImage, OutboundGuardError } from "@/lib/chart-outbound.server";
import { chartExtractionSchema } from "@/lib/chart-extract.functions";

/**
 * End-to-end guarantee for the chart-scan pipeline:
 * NO patient identifier (hospital number, name, initials, DOB, NHS number)
 * may appear in anything sent to Gemini, nor survive in the structured
 * extraction returned to the app.
 *
 * The test drives the real outbound path — data-URL guard -> image metadata
 * stripping -> prompt/message builder -> response schema -> identifier scrub —
 * and scans every byte and every string that leaves or enters the boundary.
 */

const IDENTIFIERS = [
  "SMITH", // surname on the sticker
  "John", // forename
  "1234567", // hospital number
  "RXK1234567", // hospital number with prefix
  "943 476 5919", // NHS number
  "1948-03-04", // DOB
  "JS", // initials (checked separately, word-boundary)
];

/** Every string reachable in a JSON-serialisable value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  return out;
}

function u8(...parts: Array<number[] | Uint8Array | string>): Uint8Array {
  const chunks = parts.map((p) =>
    typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p),
  );
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toDataUrl(mime: string, bytes: Uint8Array, extraHeaderParams = ""): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:${mime}${extraHeaderParams};base64,${btoa(bin)}`;
}

/**
 * A JPEG whose metadata is stuffed with identifiers, exactly the way a phone
 * photo of a chart with a patient sticker could carry them (EXIF description,
 * XMP, IPTC caption, JPEG comment, plus a data-URL `name=` parameter).
 */
function hostileJpeg(): Uint8Array {
  const exif = u8("Exif\0\0", "ImageDescription: SMITH John 1234567 DOB 1948-03-04");
  const xmp = u8("http://ns.adobe.com/xap/1.0/\0", "<dc:title>RXK1234567 SMITH</dc:title>");
  const iptc = u8("Photoshop 3.0\0", "Caption: patient JS NHS 943 476 5919");
  const comment = u8("Ward round chart for John Smith 1234567");
  const seg = (marker: number, payload: Uint8Array) =>
    u8([0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff], payload);
  return u8(
    [0xff, 0xd8], // SOI
    seg(0xe1, exif), // APP1 EXIF
    seg(0xe1, xmp), // APP1 XMP
    seg(0xed, iptc), // APP13 IPTC
    seg(0xfe, comment), // COM
    seg(0xdb, new Uint8Array(64).fill(0x10)), // DQT (real image data, kept)
    [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00], // SOS
    new Uint8Array(64).fill(0x7a), // entropy-coded data
    [0xff, 0xd9], // EOI
  );
}

describe("chart scan: no patient identifiers reach Gemini", () => {
  const chartDate = "2026-08-26";

  it("strips identifier-bearing metadata from the image before it leaves the server", () => {
    const dataUrl = toDataUrl("image/jpeg", hostileJpeg(), ";name=SMITH_John_1234567.jpg");
    const safe = sanitiseOutboundImage(dataUrl);

    // The bytes actually sent upstream, decoded again.
    const b64 = safe.dataUrl.slice(safe.dataUrl.indexOf(",") + 1);
    const raw = atob(b64);

    for (const id of IDENTIFIERS) expect(raw).not.toContain(id);
    expect(safe.dataUrl).not.toMatch(/name=/i);
    expect(safe.mime).toBe("image/jpeg");
    // Evidence of what was removed (types only, never contents).
    expect(safe.strippedSegments.join(",")).toMatch(/EXIF|XMP|IPTC|COM|DATAURL/i);
    expect(safe.strippedSegments.join(" ")).not.toContain("SMITH");
    // The picture itself survived.
    expect(raw.startsWith("\xff\xd8")).toBe(true);
    expect(raw).toContain("\x7a\x7a\x7a"); // entropy-coded pixel data preserved
  });

  it("builds a prompt containing no identifier — only the ISO chart date", () => {
    const safe = sanitiseOutboundImage(toDataUrl("image/jpeg", hostileJpeg()));
    const messages = buildChartExtractionMessages(chartDate, [safe.dataUrl]);

    const textParts = collectStrings(
      messages.map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text"),
      ),
    );
    const allText = textParts.join("\n");

    for (const id of IDENTIFIERS.filter((i) => i !== "JS")) {
      expect(allText).not.toContain(id);
    }
    expect(allText).not.toMatch(/\bJS\b/);
    // Only the date is interpolated, and the model is told not to return ids.
    expect(allText).toContain(chartDate);
    expect(CHART_SYSTEM_PROMPT).toMatch(/Do NOT return ANY patient identifier/);

    // Image parts are canonical data URLs with no header free-text channel.
    const images = messages.flatMap((m) =>
      typeof m.content === "string" ? [] : m.content.filter((p) => p.type === "image_url"),
    );
    expect(images).toHaveLength(1);
    for (const img of images) {
      expect(img.type === "image_url" && img.image_url.url).toMatch(
        /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/,
      );
    }
  });

  it("cannot be tricked into interpolating an identifier as the chart date", () => {
    expect(() => buildChartExtractionMessages("2026-08-26 MRN 1234567", [])).toThrow();
    expect(() => buildChartExtractionMessages("SMITH John", [])).toThrow();
  });

  it("refuses non-raster payloads that could smuggle text upstream", () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg><text>SMITH John 1234567</text></svg>')}`;
    expect(() => sanitiseOutboundImage(svg)).toThrow(OutboundGuardError);
    const pdf = `data:application/pdf;base64,${btoa("%PDF-1.4 SMITH John 1234567".padEnd(64, " "))}`;
    expect(() => sanitiseOutboundImage(pdf)).toThrow(OutboundGuardError);
  });

  it("discards every identifier the model returns in the structured extraction", () => {
    // A hostile/hallucinating model response that reads the sticker anyway.
    const modelJson = {
      chart_date: chartDate,
      hospital_number: "RXK1234567",
      initials: "JS",
      balance_24h_ml: -250,
      hourly: [{ hour: 7, hr: 92 }],
      investigations: [{ category: "CXR", findings: "R basal atelectasis" }],
      microbiology: [],
      assessments: { resp: "Wean PS" },
      notes: null,
      overall_confidence: 0.82,
      low_confidence: ["hospital_number", "initials", "hourly[7].hr"],
    };

    const parsed = chartExtractionSchema.parse(modelJson);
    const scrubbed = scrubExtractionIdentifiers(parsed);

    expect(scrubbed.hospital_number).toBeNull();
    expect(scrubbed.initials).toBeNull();
    expect(scrubbed.low_confidence).toEqual(["hourly[7].hr"]);

    const strings = collectStrings(scrubbed);
    for (const id of IDENTIFIERS.filter((i) => i !== "JS")) {
      expect(strings.join("|")).not.toContain(id);
    }
    expect(strings.join(" ")).not.toMatch(/\bJS\b/);

    // Clinical payload survives the scrub.
    expect(scrubbed.hourly[0]?.hr).toBe(92);
    expect(scrubbed.investigations[0]?.findings).toBe("R basal atelectasis");
  });
});
