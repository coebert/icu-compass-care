import { useState } from "react";
import type { ChartExtraction } from "@/lib/chart-extract.functions";


/**
 * Compact digital chart preview: a fixed 24-hour timeline showing sparklines
 * for the key vitals plus a fluid-balance strip, so timings and trends can be
 * eyeballed before the extraction is committed. Pure SVG — no chart lib.
 *
 * Out-of-range dots are clickable and scroll/focus the matching cell in the
 * detailed review table below so the reviewer can jump straight to the value
 * that needs confirmation.
 */

function focusChartCell(hour: number, key: string) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(`chart-cell-${hour}-${key}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const input = el.querySelector<HTMLInputElement>("input");
  if (input) {
    input.focus();
    input.select();
  }
  const flashClasses = ["ring-2", "ring-primary", "ring-offset-1", "ring-offset-background"];
  el.classList.add(...flashClasses);
  window.setTimeout(() => el.classList.remove(...flashClasses), 1500);
}


type Series = {
  key: string;
  label: string;
  unit?: string;
  yMin: number;
  yMax: number;
  bands?: { lo: number; hi: number; tone: "ok" | "warn" }[];
  stroke: string;
  precision?: number;
};

const SERIES: Series[] = [
  {
    key: "hr",
    label: "HR",
    unit: "bpm",
    yMin: 30,
    yMax: 180,
    bands: [{ lo: 50, hi: 130, tone: "ok" }],
    stroke: "hsl(0 72% 55%)",
  },
  {
    key: "map",
    label: "MAP",
    unit: "mmHg",
    yMin: 40,
    yMax: 140,
    bands: [{ lo: 65, hi: 110, tone: "ok" }],
    stroke: "hsl(220 70% 55%)",
  },
  {
    key: "spo2",
    label: "SpO₂",
    unit: "%",
    yMin: 80,
    yMax: 100,
    bands: [{ lo: 92, hi: 100, tone: "ok" }],
    stroke: "hsl(190 80% 45%)",
  },
  {
    key: "rr",
    label: "RR",
    unit: "/min",
    yMin: 5,
    yMax: 40,
    bands: [{ lo: 10, hi: 25, tone: "ok" }],
    stroke: "hsl(280 60% 55%)",
  },
  {
    key: "temp",
    label: "Temp",
    unit: "°C",
    yMin: 34,
    yMax: 40,
    bands: [{ lo: 36, hi: 38, tone: "ok" }],
    stroke: "hsl(20 85% 55%)",
    precision: 1,
  },
  {
    key: "fio2",
    label: "FiO₂",
    yMin: 0.2,
    yMax: 1,
    bands: [{ lo: 0.21, hi: 0.4, tone: "ok" }],
    stroke: "hsl(160 60% 40%)",
    precision: 2,
  },
];

export function ChartTrendPreview({
  extraction,
  lowConf,
}: {
  extraction: ChartExtraction;
  lowConf?: Set<string>;
}) {
  const byHour = new Map<number, Record<string, number | null>>();
  for (const row of extraction.hourly) {
    byHour.set(row.hour, row as unknown as Record<string, number | null>);
  }
  const lc = lowConf ?? new Set<string>();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          24h Chart preview
        </p>
        <p className="text-[11px] text-muted-foreground">
          Hover or tap any point to inspect the extracted value, hour, and OCR confidence.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {SERIES.map((s) => (
          <Sparkline key={s.key} series={s} byHour={byHour} lowConf={lc} />
        ))}
      </div>
      <BalanceStrip byHour={byHour} />
    </div>
  );
}


function Sparkline({
  series,
  byHour,
  lowConf,
}: {
  series: Series;
  byHour: Map<number, Record<string, number | null>>;
  lowConf: Set<string>;
}) {
  const W = 320;
  const H = 74;
  const padL = 30;
  const padR = 6;
  const padT = 8;
  const padB = 14;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const [activeHour, setActiveHour] = useState<number | null>(null);

  const xForHour = (h: number) => padL + (h / 23) * innerW;
  const yForVal = (v: number) => {
    const clamped = Math.max(series.yMin, Math.min(series.yMax, v));
    const t = (clamped - series.yMin) / (series.yMax - series.yMin);
    return padT + (1 - t) * innerH;
  };

  // Build path with gaps for missing hours.
  let d = "";
  let penDown = false;
  const points: { h: number; v: number; oor: boolean; uncertain: boolean }[] = [];
  for (let h = 0; h < 24; h += 1) {
    const raw = byHour.get(h)?.[series.key];
    if (raw == null || Number.isNaN(raw as number)) {
      penDown = false;
      continue;
    }
    const v = raw as number;
    const x = xForHour(h);
    const y = yForVal(v);
    d += `${penDown ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    penDown = true;
    const oor = series.bands?.some((b) => v < b.lo || v > b.hi) ?? false;
    const uncertain = lowConf.has(`hourly[${h}].${series.key}`);
    points.push({ h, v, oor, uncertain });
  }

  const lastVal = points.at(-1)?.v;
  const active = activeHour == null ? null : points.find((p) => p.h === activeHour) ?? null;
  const bandStr = series.bands?.[0]
    ? `${series.precision != null ? series.bands[0].lo.toFixed(series.precision) : series.bands[0].lo}–${
        series.precision != null ? series.bands[0].hi.toFixed(series.precision) : series.bands[0].hi
      }${series.unit ?? ""}`
    : null;


  const activeX = active ? xForHour(active.h) : null;
  const popoverOnRight = activeX != null && activeX < W / 2;

  return (
    <div className="relative rounded border p-2">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium">
          {series.label}
          {series.unit ? <span className="ml-1 text-muted-foreground">{series.unit}</span> : null}
          {bandStr && (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              typical {bandStr}
            </span>
          )}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {lastVal == null
            ? "no data"
            : series.precision != null
              ? lastVal.toFixed(series.precision)
              : String(lastVal)}
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${series.label} over 24 hours`}
          className="h-[74px] w-full"
          onMouseLeave={() => setActiveHour(null)}
        >
          {/* target band */}
          {series.bands?.map((b, i) => (
            <rect
              key={i}
              x={padL}
              y={yForVal(b.hi)}
              width={innerW}
              height={Math.max(1, yForVal(b.lo) - yForVal(b.hi))}
              fill="hsl(150 60% 45% / 0.12)"
            />
          ))}
          {/* y-axis labels */}
          <text x={4} y={padT + 6} className="fill-muted-foreground" fontSize="9">
            {series.precision != null ? series.yMax.toFixed(series.precision) : series.yMax}
          </text>
          <text x={4} y={H - padB + 3} className="fill-muted-foreground" fontSize="9">
            {series.precision != null ? series.yMin.toFixed(series.precision) : series.yMin}
          </text>
          {/* x-axis hour ticks (0, 6, 12, 18) */}
          {[0, 6, 12, 18, 23].map((h) => (
            <g key={h}>
              <line
                x1={xForHour(h)}
                x2={xForHour(h)}
                y1={padT}
                y2={H - padB}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <text
                x={xForHour(h)}
                y={H - 3}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize="8"
              >
                {String(h).padStart(2, "0")}
              </text>
            </g>
          ))}
          {/* line */}
          {d && (
            <path d={d} fill="none" stroke={series.stroke} strokeWidth={1.5} strokeLinejoin="round" />
          )}
          {/* active hour guide */}
          {active && (
            <line
              x1={xForHour(active.h)}
              x2={xForHour(active.h)}
              y1={padT}
              y2={H - padB}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="2 2"
            />
          )}
          {/* points */}
          {points.map((p) => {
            const isActive = active?.h === p.h;
            const r = isActive ? 3.2 : p.oor ? 2.5 : 1.6;
            return (
              <g key={p.h}>
                <circle
                  cx={xForHour(p.h)}
                  cy={yForVal(p.v)}
                  r={r}
                  fill={p.oor ? "hsl(30 90% 55%)" : series.stroke}
                  stroke={p.oor ? "hsl(30 90% 40%)" : isActive ? "hsl(var(--primary))" : "none"}
                  strokeWidth={isActive ? 1 : p.oor ? 0.75 : 0}
                />
                {/* Larger invisible hit target for hover/click/keyboard */}
                <circle
                  cx={xForHour(p.h)}
                  cy={yForVal(p.v)}
                  r={9}
                  fill="transparent"
                  className="cursor-pointer focus:outline-none"
                  onMouseEnter={() => setActiveHour(p.h)}
                  onFocus={() => setActiveHour(p.h)}
                  onBlur={() => setActiveHour((h) => (h === p.h ? null : h))}
                  onClick={() => setActiveHour((h) => (h === p.h ? null : p.h))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      focusChartCell(p.h, series.key);
                    } else if (e.key === "Escape") {
                      setActiveHour(null);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${series.label} at ${String(p.h).padStart(2, "0")}:00 — ${
                    series.precision != null ? p.v.toFixed(series.precision) : p.v
                  }${series.unit ?? ""}${p.uncertain ? ", OCR uncertain" : ""}${
                    p.oor ? ", outside typical range" : ""
                  }. Enter to jump to detailed cell.`}
                />
              </g>
            );
          })}
        </svg>
        {active && (
          <PointPopover
            series={series}
            point={active}
            bandStr={bandStr}
            side={popoverOnRight ? "right" : "left"}
            onJump={() => focusChartCell(active.h, series.key)}
            onClose={() => setActiveHour(null)}
          />
        )}
      </div>
    </div>
  );
}

function PointPopover({
  series,
  point,
  bandStr,
  side,
  onJump,
  onClose,
}: {
  series: Series;
  point: { h: number; v: number; oor: boolean; uncertain: boolean };
  bandStr: string | null;
  side: "left" | "right";
  onJump: () => void;
  onClose: () => void;
}) {
  const valueStr = series.precision != null ? point.v.toFixed(series.precision) : String(point.v);
  return (
    <div
      role="dialog"
      aria-label={`${series.label} value details`}
      className={`absolute top-1 z-20 w-52 rounded-md border bg-popover p-2 text-xs shadow-md ${
        side === "right" ? "right-2" : "left-2"
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">
          {series.label} · {String(point.h).padStart(2, "0")}:00
        </span>
        <button
          type="button"
          className="rounded px-1 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ×
        </button>
      </div>
      <div className="font-mono text-base tabular-nums">
        {valueStr}
        {series.unit && <span className="ml-1 text-xs text-muted-foreground">{series.unit}</span>}
      </div>
      {bandStr && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          typical {bandStr}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {point.uncertain ? (
          <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            OCR uncertain
          </span>
        ) : (
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
            OCR confident
          </span>
        )}
        {point.oor && (
          <span className="rounded-full border border-orange-500/50 bg-orange-500/10 px-1.5 py-0 text-[10px] font-medium text-orange-700 dark:text-orange-400">
            outside typical
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onJump}
        className="mt-2 w-full rounded border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
      >
        Jump to detailed row →
      </button>
    </div>
  );
}


function BalanceStrip({
  byHour,
}: {
  byHour: Map<number, Record<string, number | null>>;
}) {
  // Prefer hourly_balance_ml if present; else derive intake − urine.
  const values: (number | null)[] = [];
  for (let h = 0; h < 24; h += 1) {
    const row = byHour.get(h);
    if (!row) {
      values.push(null);
      continue;
    }
    if (row.hourly_balance_ml != null) {
      values.push(row.hourly_balance_ml as number);
    } else {
      const inV = (row.intake_ml as number | null) ?? 0;
      const outV =
        ((row.urine_ml as number | null) ?? 0) +
        ((row.ng_free_ml as number | null) ?? 0) +
        ((row.actual_removal_ml as number | null) ?? 0);
      const derived = (row.intake_ml == null && row.urine_ml == null && row.ng_free_ml == null && row.actual_removal_ml == null)
        ? null
        : inV - outV;
      values.push(derived);
    }
  }

  const max = Math.max(
    100,
    ...values.filter((v): v is number => v != null).map((v) => Math.abs(v)),
  );

  return (
    <div className="rounded border p-2">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium">
          Hourly fluid balance <span className="text-muted-foreground">mL</span>
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          scale ±{max}
        </span>
      </div>
      <div className="grid grid-cols-24 gap-[1px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
        {values.map((v, h) => {
          const pct = v == null ? 0 : Math.min(1, Math.abs(v) / max);
          const positive = (v ?? 0) > 0;
          const height = Math.max(2, pct * 28);
          return (
            <div key={h} className="relative h-8" title={`${String(h).padStart(2, "0")}:00 — ${v == null ? "no data" : `${v > 0 ? "+" : ""}${v} mL`}`}>
              <div className="absolute left-0 right-0 top-1/2 h-px bg-border" />
              {v != null && (
                <div
                  className={`absolute left-1/2 -translate-x-1/2 rounded-sm ${
                    positive ? "bg-emerald-500/70" : "bg-rose-500/70"
                  }`}
                  style={{
                    height,
                    width: "80%",
                    [positive ? "bottom" : "top"]: "50%",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between px-[1px] text-[9px] text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}
