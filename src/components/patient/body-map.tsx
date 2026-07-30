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
          {/* Simplified anterior figure */}
          <g
            className="fill-muted stroke-border"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <circle cx="100" cy="46" r="26" />
            <path d="M100 72 h0 M86 78 h28 l6 8 v6 h-40 v-6 z" />
            <path d="M72 92 h56 l10 22 v70 l-8 60 h-60 l-8 -60 v-70 z" />
            {/* arms */}
            <path d="M72 96 l-22 12 -12 76 -6 66 h16 l10 -62 14 -50 z" />
            <path d="M128 96 l22 12 12 76 6 66 h-16 l-10 -62 -14 -50 z" />
            {/* legs */}
            <path d="M82 244 l-6 92 -4 74 h22 l6 -74 6 -60 z" />
            <path d="M118 244 l6 92 4 74 h-22 l-6 -74 -6 -60 z" />
          </g>
          {/* midline for orientation */}
          <line
            x1="100"
            y1="80"
            x2="100"
            y2="240"
            className="stroke-border"
            strokeDasharray="3 5"
            strokeWidth={1}
          />
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
