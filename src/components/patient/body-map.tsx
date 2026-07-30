import { useMemo, useState } from "react";
import { LINE_TYPE_LABEL, LINE_REVIEW_DAYS, type LineType } from "@/lib/lines.functions";
import { type PatientLine, daysInSitu } from "@/lib/lines";
import { fmtDate, fmtDateTime } from "@/lib/icu";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Scrolls to and briefly highlights the matching row in the device list. */
function focusLineRow(id: string) {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(`[data-line-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-primary");
  window.setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 1800);
}


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

export type BodyMapPlacement = {
  device_type: LineType;
  site: string;
  laterality: "" | "left" | "right";
  region: string;
  x: number;
  y: number;
};

/**
 * Canonical anatomical sites. Clicks/drags snap to the nearest of these so the
 * pre-filled site text is always drawn from one consistent vocabulary.
 */
type SiteAnchor = {
  site: string;
  y: number;
  /** Distance from midline; omitted for midline-only structures. */
  lateral?: number;
  device_type: LineType;
  /** Midline structures have no meaningful laterality. */
  midlineOnly?: boolean;
};

export const SITE_ANCHORS: SiteAnchor[] = [
  { site: "Nose / mouth", y: 62, device_type: "ng_tube", midlineOnly: true },
  { site: "Mouth / airway", y: 80, device_type: "ett", midlineOnly: true },
  { site: "Anterior neck", y: 104, device_type: "tracheostomy", midlineOnly: true },
  { site: "Internal jugular", y: 98, lateral: 18, device_type: "central_venous_catheter" },
  { site: "Subclavian", y: 122, lateral: 30, device_type: "central_venous_catheter" },
  { site: "Chest", y: 155, lateral: 34, device_type: "chest_drain" },
  { site: "Abdomen", y: 212, lateral: 24, device_type: "surgical_drain" },
  { site: "Bladder / urethra", y: 240, device_type: "urinary_catheter", midlineOnly: true },
  { site: "Femoral", y: 265, lateral: 22, device_type: "vascath" },
  { site: "Upper arm", y: 180, lateral: 46, device_type: "picc" },
  { site: "Antecubital fossa", y: 215, lateral: 52, device_type: "peripheral_cannula" },
  { site: "Radial / wrist", y: 255, lateral: 58, device_type: "arterial_line" },
  { site: "Hand", y: 288, lateral: 60, device_type: "peripheral_cannula" },
  { site: "Thigh", y: 320, lateral: 22, device_type: "other" },
  { site: "Leg", y: 355, lateral: 24, device_type: "other" },
  { site: "Foot / ankle", y: 388, lateral: 26, device_type: "other" },
];

/**
 * Reverse lookup: snap a click on the figure to the nearest anatomical site and
 * return the suggested device/site/side plus the snapped coordinates.
 */
function regionAt(x: number, y: number): BodyMapPlacement {
  const side: "" | "left" | "right" = x > 100 ? "left" : "right";
  let best: { anchor: SiteAnchor; x: number; d: number } | null = null;

  for (const anchor of SITE_ANCHORS) {
    const candidates = anchor.midlineOnly
      ? [100]
      : anchor.lateral
        ? [100 - anchor.lateral, 100 + anchor.lateral]
        : [100];
    for (const cx of candidates) {
      const d = Math.hypot(cx - x, anchor.y - y);
      if (!best || d < best.d) best = { anchor, x: cx, d };
    }
  }

  const { anchor, x: snappedX } = best!;
  return {
    device_type: anchor.device_type,
    site: anchor.site,
    region: anchor.site,
    laterality: anchor.midlineOnly ? "" : snappedX > 100 ? "left" : snappedX < 100 ? "right" : side,
    x: snappedX,
    y: anchor.y,
  };
}


/** Visual map of where each in-situ line/device sits on the patient. */
export function BodyMap({
  lines,
  onPlace,
  onMoveMarker,
  renderMarkerActions,
}: {
  lines: PatientLine[];
  onPlace?: (placement: BodyMapPlacement) => void;
  onMoveMarker?: (line: PatientLine, placement: BodyMapPlacement) => void;
  renderMarkerActions?: (line: PatientLine) => React.ReactNode;
}) {

  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState<BodyMapPlacement | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; moved: boolean } | null>(
    null,
  );

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

  if (lines.length === 0 && !onPlace) return null;

  const toSvg = (target: SVGSVGElement, clientX: number, clientY: number) => {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * 200,
      y: ((clientY - rect.top) / rect.height) * 420,
    };
  };

  const handleMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPlace || drag?.moved) return;
    const pt = toSvg(e.currentTarget, e.clientX, e.clientY);
    if (!pt) return;
    const placement = regionAt(pt.x, pt.y);
    setPending(placement);
    setActiveId(null);
    onPlace(placement);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const pt = toSvg(e.currentTarget, e.clientX, e.clientY);
    if (!pt) return;
    setDrag({ ...drag, ...pt, moved: true });
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const current = drag;
    setDrag(null);
    if (!current.moved || !onMoveMarker) return;
    const line = lines.find((l) => l.id === current.id);
    if (!line) return;
    const placement = regionAt(current.x, current.y);
    onMoveMarker(line, placement);
    e.stopPropagation();
  };

  return (
    <TooltipProvider delayDuration={150}>
    <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-[220px_1fr]">
      <div className="mx-auto w-full max-w-[220px]">
        <svg

          viewBox="0 0 200 420"
          role="img"
          aria-label="Body map showing the position of lines and devices"
          onClick={handleMapClick}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={() => setDrag(null)}
          className={
            "w-full touch-none " + (drag ? "cursor-grabbing " : onPlace ? "cursor-crosshair" : "")
          }
        >


          {/* Anatomical anterior figure: each region drawn once and mirrored. */}
          <g
            className="fill-muted stroke-border"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            {[false, true].map((mirror) => {
              const t = mirror ? "translate(200,0) scale(-1,1)" : undefined;
              return (
                <g key={String(mirror)} transform={t}>
                  {/* head, neck and torso */}
                  <path
                    d="M100 16 C87 16 77 27 77 44 C77 57 82 67 90 72
                       C90 78 90 82 88 85 C80 90 70 94 62 100
                       C54 106 50 116 49 128
                       C56 132 60 140 61 152
                       C62 168 62 180 64 192
                       C66 206 70 216 74 226
                       C80 238 90 246 100 250
                       V16 Z"
                  />
                  {/* arm: shoulder, upper arm, elbow, forearm, hand */}
                  <path
                    d="M49 122 C40 126 34 136 32 150
                       C30 166 28 184 26 200
                       C24 216 21 234 19 250
                       C17 262 15 272 17 280
                       C19 289 27 292 32 287
                       C37 282 39 270 41 258
                       C44 240 48 220 51 202
                       C54 184 57 166 58 150
                       C59 138 56 128 49 122 Z"
                  />
                  {/* leg: thigh, knee, calf, ankle and foot */}
                  <path
                    d="M76 232 C72 254 70 280 71 306
                       C72 330 74 350 75 370
                       C76 386 77 398 78 408
                       C72 411 68 415 71 418 L95 418
                       C97 404 97 386 96 366
                       C95 340 96 312 97 288
                       C98 268 99 254 100 244
                       C93 244 84 240 76 232 Z"
                  />
                </g>
              );
            })}
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

          {/* Snap preview: shows where a dragged marker will land. */}
          {drag?.moved &&
            (() => {
              const snap = regionAt(drag.x, drag.y);
              return (
                <g className="pointer-events-none">
                  <circle
                    cx={snap.x}
                    cy={snap.y}
                    r={9}
                    className="fill-primary/10 stroke-primary/60"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={snap.x > 100 ? snap.x + 12 : snap.x - 12}
                    y={snap.y - 12}
                    textAnchor={snap.x > 100 ? "start" : "end"}
                    fontSize="9"
                    className="fill-muted-foreground"
                  >
                    {snap.site}
                  </text>
                </g>
              );
            })()}


          {markers.map((m) => {
            const overdue = isOverdue(m.line);
            const selected = m.line.id === activeId;
            const dragging = drag?.id === m.line.id && drag.moved;
            const cx = dragging ? drag.x : m.x;
            const cy = dragging ? drag.y : m.y;
            const days = daysInSitu(m.line);
            const limit = LINE_REVIEW_DAYS[m.line.device_type as LineType];
            return (
              <Tooltip key={m.line.id}>
                <TooltipTrigger asChild>
                  <g
                    onPointerDown={(e) => {
                      if (!onMoveMarker) return;
                      e.currentTarget.releasePointerCapture?.(e.pointerId);
                      setDrag({ id: m.line.id, x: m.x, y: m.y, moved: false });
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (drag?.moved) return;
                      setActiveId((v) => (v === m.line.id ? null : m.line.id));
                      focusLineRow(m.line.id);
                    }}
                    className={onMoveMarker ? "cursor-grab" : "cursor-pointer"}
                  >
                    <circle
                      cx={cx}
                      cy={cy}
                      r={selected || dragging ? 9 : 7}
                      className={
                        overdue
                          ? "fill-rose-500 stroke-background"
                          : "fill-primary stroke-background"
                      }
                      strokeWidth={2}
                      opacity={dragging ? 0.85 : 1}
                    />
                    {(selected || dragging) && (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={13}
                        className="fill-none stroke-primary"
                        strokeWidth={2}
                        strokeDasharray={dragging ? "3 3" : undefined}
                      />
                    )}
                  </g>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-56 space-y-0.5">
                  <p className="font-medium">
                    {LINE_TYPE_LABEL[m.line.device_type as LineType] ?? m.line.device_type}
                  </p>
                  <p className="text-xs">
                    {m.line.site || m.region}
                    {m.line.laterality ? ` (${m.line.laterality})` : ""}
                  </p>
                  <p className="text-xs">
                    Last reviewed {fmtDateTime(m.line.updated_at)}
                    {days !== null && limit != null
                      ? ` · day ${days} of ${limit}${overdue ? " (review overdue)" : ""}`
                      : days !== null
                        ? ` · day ${days}`
                        : ""}
                  </p>
                  <p className="text-xs opacity-80">
                    Click to open in the device list
                    {onMoveMarker ? " · drag to reposition" : ""}
                  </p>
                </TooltipContent>
              </Tooltip>
            );
          })}



          {pending && (
            <g pointerEvents="none">
              <circle
                cx={pending.x}
                cy={pending.y}
                r={8}
                className="fill-none stroke-emerald-500"
                strokeWidth={2}
                strokeDasharray="3 3"
              />
              <path
                d={`M${pending.x - 12} ${pending.y} h24 M${pending.x} ${pending.y - 12} v24`}
                className="stroke-emerald-500"
                strokeWidth={1.2}
              />
            </g>
          )}
        </svg>
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          Anterior view · sides are the patient&apos;s own
        </p>
        {onPlace && (
          <p className="mt-1 text-center text-[11px] text-muted-foreground">
            Click anywhere on the figure to add a device there
            {onMoveMarker ? ", or drag a marker to reposition it" : ""}. Positions snap to the
            nearest named anatomical site.
          </p>

        )}
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
          {pending && (
            <span className="text-emerald-600">
              New device position: {pending.region}
              {pending.laterality ? ` (${pending.laterality})` : ""}
            </span>
          )}
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
          <div className="space-y-2 rounded-md border bg-muted/40 p-2">
            <p className="text-xs text-muted-foreground">
              {LINE_TYPE_LABEL[active.line.device_type as LineType]} · mapped to {active.region}
              {active.side === 0 ? " (side not recorded)" : ""}
              {active.line.inserted_on ? ` · inserted ${fmtDate(active.line.inserted_on)}` : ""}
            </p>
            {renderMarkerActions?.(active.line)}
          </div>
        )}

      </div>
    </div>
    </TooltipProvider>
  );

}
