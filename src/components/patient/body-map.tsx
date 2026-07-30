import { useMemo, useState } from "react";
import { LINE_TYPE_LABEL, LINE_REVIEW_DAYS, type LineType } from "@/lib/lines.functions";
import { type PatientLine, daysInSitu } from "@/lib/lines";
import { fmtDate } from "@/lib/icu";
import { Badge } from "@/components/ui/badge";

/**
 * Simplified anterior body map. Coordinates are on a 200 x 420 viewBox where the
 * midline is x=100. Positive dx moves to the patient's LEFT (viewer's right).
 */
type Anchor = { x: number; y: number; label: string; lateral?: number };

const BASE: Record<LineType, Anchor> = {
  central_venous_catheter: { x: 100, y: 96, label: "Neck / subclavian", lateral: 20 },
  arterial_line: { x: 100, y: 250, label: "Wrist (radial)", lateral: 56 },
  peripheral_cannula: { x: 100, y: 228, label: "Forearm", lateral: 52 },
  vascath: { x: 100, y: 100, label: "Neck / femoral", lateral: 18 },
  picc: { x: 100, y: 190, label: "Upper arm", lateral: 46 },
  midline: { x: 100, y: 205, label: "Upper arm", lateral: 46 },
  urinary_catheter: { x: 100, y: 236, label: "Bladder / urethra" },
  ng_tube: { x: 100, y: 62, label: "Nose / mouth", lateral: 6 },
  chest_drain: { x: 100, y: 150, label: "Chest wall", lateral: 30 },
  surgical_drain: { x: 100, y: 212, label: "Abdomen", lateral: 22 },
  epidural: { x: 100, y: 200, label: "Spine (posterior)", lateral: 10 },
  tracheostomy: { x: 100, y: 104, label: "Anterior neck" },
  ett: { x: 100, y: 78, label: "Mouth / airway" },
  other: { x: 100, y: 300, label: "Unspecified", lateral: 34 },
};

/** Site free text often carries better anatomy than the device default. */
const SITE_HINTS: { match: RegExp; y: number; lateral?: number; label: string }[] = [
  { match: /femoral|groin/, y: 262, lateral: 22, label: "Femoral" },
  { match: /\bij\b|jugular|neck/, y: 96, lateral: 18, label: "Internal jugular" },
  { match: /subclavian/, y: 118, lateral: 30, label: "Subclavian" },
  { match: /radial|wrist/, y: 250, lateral: 56, label: "Radial / wrist" },
  { match: /brachial|antecubital|acf|cubital/, y: 208, lateral: 50, label: "Antecubital fossa" },
  { match: /dorsum|hand/, y: 272, lateral: 60, label: "Hand" },
  { match: /foot|ankle|dorsalis|pedis/, y: 380, lateral: 26, label: "Foot / ankle" },
  { match: /thigh|leg/, y: 320, lateral: 22, label: "Leg" },
  { match: /abdo|umbilic|flank|drain site/, y: 212, lateral: 24, label: "Abdomen" },
  { match: /chest|pleural|thorac|axilla/, y: 150, lateral: 32, label: "Chest" },
];

function sideFactor(line: PatientLine): number {
  const text = `${line.laterality ?? ""} ${line.site ?? ""}`.toLowerCase();
  if (/\bleft\b|\bl\b|\blt\b/.test(text)) return 1; // patient's left = viewer right
  if (/\bright\b|\br\b|\brt\b/.test(text)) return -1;
  return 0;
}

function place(line: PatientLine) {
  const base = BASE[line.device_type as LineType] ?? BASE.other;
  const site = (line.site ?? "").toLowerCase();
  const hint = SITE_HINTS.find((h) => h.match.test(site));
  const y = hint?.y ?? base.y;
  const lateral = hint?.lateral ?? base.lateral ?? 0;
  const region = hint?.label ?? base.label;
  const side = sideFactor(line);
  const x = 100 + side * lateral;
  return { x, y, region, side };
}

function isOverdue(line: PatientLine) {
  const days = daysInSitu(line);
  const limit = LINE_REVIEW_DAYS[line.device_type as LineType];
  return days !== null && limit != null && days >= limit;
}

/** Visual map of where each in-situ line/device sits on the patient. */
export function BodyMap({ lines }: { lines: PatientLine[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const markers = useMemo(() => {
    const placed = lines.map((line) => ({ line, ...place(line) }));
    // Nudge apart markers that would otherwise sit on top of each other.
    const seen = new Map<string, number>();
    return placed.map((m) => {
      const key = `${Math.round(m.x / 10)}:${Math.round(m.y / 10)}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return { ...m, y: m.y + n * 11, x: m.x + (n % 2 === 0 ? 0 : 7) };
    });
  }, [lines]);

  const active = markers.find((m) => m.line.id === activeId) ?? null;

  if (lines.length === 0) return null;

  return (
    <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-[220px_1fr]">
      <div className="mx-auto w-full max-w-[220px]">
        <svg
          viewBox="0 0 200 420"
          role="img"
          aria-label="Body map showing the position of lines and devices"
          className="w-full"
        >
          {/* Anatomical anterior silhouette, drawn as one half and mirrored. */}
          <g
            className="fill-muted stroke-border"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            {[false, true].map((mirror) => (
              <path
                key={String(mirror)}
                transform={mirror ? "translate(200,0) scale(-1,1)" : undefined}
                d="M100 18 C86 18 76 29 76 45 C76 58 82 68 90 72 L90 80
                   C78 86 66 90 56 98 C46 104 42 114 40 128
                   C37 149 35 169 33 189 C31 213 28 237 26 259
                   C25 269 24 277 27 283 C31 289 38 288 40 281
                   C43 269 45 255 48 241 C52 219 57 197 62 177
                   C64 167 66 151 68 133
                   C67 153 65 171 66 187 C67 201 69 211 71 221
                   C73 233 75 241 78 251
                   C76 285 74 313 74 343 C74 369 76 391 78 407
                   C72 411 70 416 76 417 L96 417
                   C98 401 97 379 97 349 C97 301 99 273 100 253 Z"
              />
            ))}
          </g>

          {/* Faint anatomical landmarks for orientation */}
          <g
            className="fill-none stroke-border"
            strokeWidth={1}
            opacity={0.75}
            strokeLinecap="round"
          >
            {/* clavicles */}
            <path d="M62 100 C74 106 84 108 100 108 C116 108 126 106 138 100" />
            {/* sternum / midline */}
            <path d="M100 108 V152" strokeDasharray="3 4" />
            {/* costal margin */}
            <path d="M74 140 C82 158 92 166 100 168 C108 166 118 158 126 140" />
            {/* umbilicus */}
            <circle cx="100" cy="196" r="2.5" className="fill-border stroke-none" />
            {/* iliac crests / inguinal creases */}
            <path d="M72 222 C82 232 92 238 100 240 C108 238 118 232 128 222" />
            {/* shoulder joints */}
            <path d="M52 108 C46 116 44 124 45 132" />
            <path d="M148 108 C154 116 156 124 155 132" />
            {/* elbows and knees */}
            <path d="M34 194 h10 M156 194 h10" />
            <path d="M84 312 C92 316 100 316 100 316 M116 312 C108 316 100 316 100 316" />
            {/* trachea / airway guide */}
            <path d="M100 74 V100" strokeDasharray="2 3" />
          </g>
          <text x="6" y="14" className="fill-muted-foreground" fontSize="10">
            Patient right
          </text>
          <text x="194" y="14" textAnchor="end" className="fill-muted-foreground" fontSize="10">
            Patient left
          </text>


          {markers.map((m) => {
            const overdue = isOverdue(m.line);
            const selected = m.line.id === activeId;
            return (
              <g
                key={m.line.id}
                onClick={() => setActiveId((v) => (v === m.line.id ? null : m.line.id))}
                className="cursor-pointer"
              >
                <title>
                  {(LINE_TYPE_LABEL[m.line.device_type as LineType] ?? m.line.device_type) +
                    (m.line.site ? ` — ${m.line.site}` : "")}
                </title>
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={selected ? 9 : 7}
                  className={
                    overdue
                      ? "fill-rose-500 stroke-background"
                      : "fill-primary stroke-background"
                  }
                  strokeWidth={2}
                />
                {selected && (
                  <circle
                    cx={m.x}
                    cy={m.y}
                    r={13}
                    className="fill-none stroke-primary"
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          })}
        </svg>
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          Anterior view · sides are the patient&apos;s own
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" /> In situ
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Review overdue
          </span>
          <span>Select a marker or a row to link the two.</span>
        </div>
        <ul className="space-y-1">
          {markers.map((m) => {
            const selected = m.line.id === activeId;
            const days = daysInSitu(m.line);
            return (
              <li key={m.line.id}>
                <button
                  type="button"
                  onClick={() => setActiveId((v) => (v === m.line.id ? null : m.line.id))}
                  aria-pressed={selected}
                  className={
                    "w-full rounded-md border px-2 py-1.5 text-left text-sm transition " +
                    (selected ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/60")
                  }
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={
                        "h-2.5 w-2.5 shrink-0 rounded-full " +
                        (isOverdue(m.line) ? "bg-rose-500" : "bg-primary")
                      }
                    />
                    <span className="font-medium">
                      {LINE_TYPE_LABEL[m.line.device_type as LineType] ?? m.line.device_type}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {m.line.site || m.region}
                      {m.line.laterality ? ` (${m.line.laterality})` : ""}
                    </span>
                    {days !== null && (
                      <Badge variant="outline" className="ml-auto text-[11px] text-muted-foreground">
                        Day {days}
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {active && (
          <p className="text-xs text-muted-foreground">
            {LINE_TYPE_LABEL[active.line.device_type as LineType]} · mapped to {active.region}
            {active.side === 0 ? " (side not recorded)" : ""}
            {active.line.inserted_on ? ` · inserted ${fmtDate(active.line.inserted_on)}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
