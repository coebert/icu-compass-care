import { useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import type { ChartExtraction } from "@/lib/chart-extract.functions";
import { ChartTrendPreview } from "@/components/patient/chart-trend-preview";


/**
 * Detailed pre-commit review of an extracted Radnor chart. Every value the
 * model returned is editable in-place so the reviewer can correct OCR
 * mistakes, override implausible readings, and fix free-text findings before
 * the extraction is written to the handover. Editing a field also clears any
 * corresponding low-confidence flag.
 *
 * Ranges are advisory, not clinical decision support — they are chosen to
 * catch obvious OCR mis-reads (e.g. HR = 350) rather than to define
 * abnormality. Values inside the range are shown plain; outside are amber
 * (mild) or rose (severe / implausible).
 */

type Range = {
  label: string;
  unit?: string;
  ok: [number, number]; // inclusive plausible range for adults
  hard?: [number, number]; // hard implausible bounds (OCR errors)
  precision?: number;
  step?: number;
};

const HOURLY_RANGES: Record<string, Range> = {
  hr: { label: "HR", unit: "bpm", ok: [50, 130], hard: [20, 250] },
  sbp: { label: "SBP", unit: "mmHg", ok: [90, 160], hard: [40, 260] },
  dbp: { label: "DBP", unit: "mmHg", ok: [45, 100], hard: [20, 180] },
  map: { label: "MAP", unit: "mmHg", ok: [65, 110], hard: [30, 180] },
  cvp: { label: "CVP", unit: "mmHg", ok: [2, 15], hard: [-5, 30] },
  spo2: { label: "SpO₂", unit: "%", ok: [92, 100], hard: [40, 100] },
  etco2: { label: "EtCO₂", unit: "kPa", ok: [4, 6.5], hard: [1, 15], precision: 1, step: 0.1 },
  rr: { label: "RR", unit: "/min", ok: [10, 25], hard: [0, 60] },
  temp: { label: "Temp", unit: "°C", ok: [36, 38], hard: [30, 42], precision: 1, step: 0.1 },
  gcs: { label: "GCS", ok: [3, 15], hard: [3, 15] },
};

const VENT_RANGES: Record<string, Range> = {
  peep: { label: "PEEP", unit: "cmH₂O", ok: [4, 15], hard: [0, 30] },
  fio2: { label: "FiO₂", ok: [0.21, 0.8], hard: [0.21, 1], precision: 2, step: 0.01 },
  p_support: { label: "PS", unit: "cmH₂O", ok: [5, 20], hard: [0, 40] },
  tv: { label: "Vt", unit: "mL", ok: [300, 650], hard: [50, 1200] },
  mv: { label: "MV", unit: "L/min", ok: [4, 12], hard: [0, 30], precision: 1, step: 0.1 },
  peak_pressure: { label: "Peak", unit: "cmH₂O", ok: [12, 30], hard: [0, 60] },
};

const FLUID_RANGES: Record<string, Range> = {
  intake_ml: { label: "In", unit: "mL", ok: [0, 300], hard: [0, 2000] },
  flushes_ml: { label: "Flush", unit: "mL", ok: [0, 100], hard: [0, 500] },
  ng_aspirate_ml: { label: "NG asp", unit: "mL", ok: [0, 300], hard: [0, 2000] },
  ng_free_ml: { label: "NG free", unit: "mL", ok: [0, 300], hard: [0, 2000] },
  urine_ml: { label: "Urine", unit: "mL", ok: [0, 300], hard: [0, 3000] },
  target_removal_ml: { label: "Tgt rem", unit: "mL", ok: [0, 500], hard: [0, 3000] },
  actual_removal_ml: { label: "Act rem", unit: "mL", ok: [0, 500], hard: [0, 3000] },
};

type Severity = "ok" | "warn" | "bad" | "empty";

function classify(v: number | null | undefined, r: Range): Severity {
  if (v == null || Number.isNaN(v)) return "empty";
  const [okLo, okHi] = r.ok;
  const [hardLo, hardHi] = r.hard ?? r.ok;
  if (v < hardLo || v > hardHi) return "bad";
  if (v < okLo || v > okHi) return "warn";
  return "ok";
}

function cellClass(sev: Severity): string {
  switch (sev) {
    case "bad":
      return "bg-destructive/15 text-destructive font-semibold";
    case "warn":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
    case "empty":
      return "text-muted-foreground/50";
    default:
      return "";
  }
}

function fmtInput(v: number | null | undefined, r: Range): string {
  if (v == null || Number.isNaN(v)) return "";
  if (r.precision != null) return v.toFixed(r.precision);
  return String(v);
}

function parseNumber(raw: string, r: Range): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (r.precision != null) {
    const p = Math.pow(10, r.precision);
    return Math.round(n * p) / p;
  }
  // integers by default
  return Math.round(n);
}

function hasAny<T extends Record<string, unknown>>(rows: T[], keys: string[]): boolean {
  return rows.some((row) => keys.some((k) => row[k] != null && row[k] !== ""));
}

function stripLowConf(extraction: ChartExtraction, path: string): string[] {
  return (extraction.low_confidence ?? []).filter((p) => p !== path);
}

export function ChartReviewSheet({
  extraction,
  lowConf,
  onChange,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
  onChange?: (e: ChartExtraction) => void;
}) {
  const rows = [...extraction.hourly].sort((a, b) => a.hour - b.hour);
  const vitalKeys = Object.keys(HOURLY_RANGES);
  const ventKeys = Object.keys(VENT_RANGES);
  const fluidKeys = Object.keys(FLUID_RANGES);
  const readOnly = !onChange;

  const outCount = rows.reduce((n, row) => {
    for (const k of [...vitalKeys, ...ventKeys, ...fluidKeys]) {
      const r = HOURLY_RANGES[k] ?? VENT_RANGES[k] ?? FLUID_RANGES[k];
      const sev = classify(row[k as keyof typeof row] as number | null, r);
      if (sev === "warn" || sev === "bad") n += 1;
    }
    return n;
  }, 0);

  const updateHourlyCell = (hour: number, key: string, value: number | null) => {
    if (!onChange) return;
    const next = extraction.hourly.map((row) =>
      row.hour === hour ? { ...row, [key]: value } : row,
    );
    onChange({
      ...extraction,
      hourly: next,
      low_confidence: stripLowConf(extraction, `hourly[${hour}].${key}`),
    });
  };

  const updateBalance = (v: number | null) => {
    if (!onChange) return;
    onChange({
      ...extraction,
      balance_24h_ml: v,
      low_confidence: stripLowConf(extraction, "balance_24h_ml"),
    });
  };

  const updateInvestigation = (idx: number, patch: Partial<ChartExtraction["investigations"][number]>) => {
    if (!onChange) return;
    const next = extraction.investigations.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    const cleared = (extraction.low_confidence ?? []).filter(
      (p) =>
        p !== `investigations[${idx}]` &&
        !p.startsWith(`investigations[${idx}].`),
    );
    onChange({ ...extraction, investigations: next, low_confidence: cleared });
  };

  const removeInvestigation = (idx: number) => {
    if (!onChange) return;
    onChange({
      ...extraction,
      investigations: extraction.investigations.filter((_, i) => i !== idx),
    });
  };

  const updateMicrobiology = (idx: number, patch: Partial<ChartExtraction["microbiology"][number]>) => {
    if (!onChange) return;
    const next = extraction.microbiology.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    const cleared = (extraction.low_confidence ?? []).filter(
      (p) =>
        p !== `microbiology[${idx}]` &&
        !p.startsWith(`microbiology[${idx}].`),
    );
    onChange({ ...extraction, microbiology: next, low_confidence: cleared });
  };

  const removeMicrobiology = (idx: number) => {
    if (!onChange) return;
    onChange({
      ...extraction,
      microbiology: extraction.microbiology.filter((_, i) => i !== idx),
    });
  };

  const updateAssessment = (system: string, text: string) => {
    if (!onChange) return;
    onChange({
      ...extraction,
      assessments: { ...(extraction.assessments ?? {}), [system]: text || null },
      low_confidence: stripLowConf(extraction, `assessments.${system}`),
    });
  };

  const updateNotes = (text: string) => {
    if (!onChange) return;
    onChange({
      ...extraction,
      notes: text || null,
      low_confidence: stripLowConf(extraction, "notes"),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border bg-muted px-2 py-0.5">
          {rows.length} hourly row{rows.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-full border bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
          {outCount} value{outCount === 1 ? "" : "s"} outside predicted range
        </span>
        {!readOnly && (
          <span className="rounded-full border bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">
            Editable — corrections clear the uncertain flag
          </span>
        )}
        <span className="text-muted-foreground">
          Ranges are typical adult ICU ranges — amber = outside expected, rose = implausible.
        </span>
      </div>

      <ChartTrendPreview extraction={extraction} />

      <VitalsTable
        rows={rows}
        keys={vitalKeys}
        ranges={HOURLY_RANGES}
        lowConf={lowConf}
        title="Vitals"
        onEdit={onChange ? updateHourlyCell : undefined}
      />

      {(hasAny(rows, ventKeys) || !readOnly) && (
        <VitalsTable
          rows={rows}
          keys={ventKeys}
          ranges={VENT_RANGES}
          lowConf={lowConf}
          title="Ventilation"
          onEdit={onChange ? updateHourlyCell : undefined}
        />
      )}

      {(hasAny(rows, fluidKeys) || !readOnly) && (
        <VitalsTable
          rows={rows}
          keys={fluidKeys}
          ranges={FLUID_RANGES}
          lowConf={lowConf}
          title="Fluids (per hour)"
          onEdit={onChange ? updateHourlyCell : undefined}
        />
      )}

      <BalanceRow
        extraction={extraction}
        lowConf={lowConf}
        onEdit={onChange ? updateBalance : undefined}
      />

      <EditableListSection
        title="Investigations"
        items={extraction.investigations.map((i, idx) => ({
          idx,
          leftLabel: "Category",
          leftValue: i.category,
          rightLabel: "Findings",
          rightValue: i.findings ?? "",
          time: i.result_at ?? "",
          uncertain:
            lowConf.has(`investigations[${idx}]`) ||
            lowConf.has(`investigations[${idx}].findings`) ||
            lowConf.has(`investigations[${idx}].category`),
        }))}
        onEditLeft={onChange ? (idx, v) => updateInvestigation(idx, { category: v }) : undefined}
        onEditRight={onChange ? (idx, v) => updateInvestigation(idx, { findings: v || null }) : undefined}
        onEditTime={onChange ? (idx, v) => updateInvestigation(idx, { result_at: v || null }) : undefined}
        onRemove={onChange ? removeInvestigation : undefined}
      />

      <EditableListSection
        title="Microbiology"
        items={extraction.microbiology.map((m, idx) => ({
          idx,
          leftLabel: "Specimen",
          leftValue: m.specimen_type,
          rightLabel: "Findings",
          rightValue: m.findings ?? "",
          time: m.result_at ?? "",
          uncertain:
            lowConf.has(`microbiology[${idx}]`) ||
            lowConf.has(`microbiology[${idx}].findings`) ||
            lowConf.has(`microbiology[${idx}].specimen_type`),
        }))}
        onEditLeft={onChange ? (idx, v) => updateMicrobiology(idx, { specimen_type: v }) : undefined}
        onEditRight={onChange ? (idx, v) => updateMicrobiology(idx, { findings: v || null }) : undefined}
        onEditTime={onChange ? (idx, v) => updateMicrobiology(idx, { result_at: v || null }) : undefined}
        onRemove={onChange ? removeMicrobiology : undefined}
      />

      <AssessmentsBlock
        extraction={extraction}
        lowConf={lowConf}
        onEdit={onChange ? updateAssessment : undefined}
      />

      <div className="rounded border p-3 text-sm">
        <p className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          NURSING NOTES
          {lowConf.has("notes") && <UncertainPill />}
        </p>
        {onChange ? (
          <textarea
            className="min-h-[70px] w-full resize-y rounded border bg-background px-2 py-1 text-sm"
            value={extraction.notes ?? ""}
            onChange={(e) => updateNotes(e.target.value)}
            placeholder="No nursing notes extracted — add corrections here."
          />
        ) : (
          <p className="whitespace-pre-wrap">{extraction.notes || "—"}</p>
        )}
      </div>
    </div>
  );
}

function VitalsTable({
  rows,
  keys,
  ranges,
  lowConf,
  title,
  onEdit,
}: {
  rows: ChartExtraction["hourly"];
  keys: string[];
  ranges: Record<string, Range>;
  lowConf: Set<string>;
  title: string;
  onEdit?: (hour: number, key: string, value: number | null) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title.toUpperCase()}</p>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="sticky left-0 z-10 bg-muted/50 px-2 py-1 text-left font-medium">
                Hour
              </th>
              {keys.map((k) => {
                const r = ranges[k];
                return (
                  <th key={k} className="px-2 py-1 text-center font-medium">
                    <div>{r.label}</div>
                    <div className="text-[10px] font-normal text-muted-foreground">
                      {r.ok[0]}–{r.ok[1]}
                      {r.unit ? ` ${r.unit}` : ""}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.hour} className="border-t">
                <td className="sticky left-0 z-10 bg-background px-2 py-1 font-mono tabular-nums">
                  {String(row.hour).padStart(2, "0")}:00
                </td>
                {keys.map((k) => {
                  const r = ranges[k];
                  const v = row[k as keyof typeof row] as number | null;
                  const sev = classify(v, r);
                  const path = `hourly[${row.hour}].${k}`;
                  const uncertain = lowConf.has(path);
                  const title =
                    uncertain
                      ? `OCR flagged uncertain · plausible ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""}`
                      : sev === "bad"
                        ? `Implausible — likely OCR error (expected ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""})`
                        : sev === "warn"
                          ? `Outside typical ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""}`
                          : "";
                  return (
                    <td
                      key={k}
                      className={`px-1 py-0.5 text-center tabular-nums ${cellClass(sev)} ${
                        uncertain ? "outline outline-1 outline-amber-500/60" : ""
                      }`}
                      title={title}
                    >
                      {onEdit ? (
                        <NumberCellInput
                          value={v}
                          range={r}
                          onCommit={(next) => onEdit(row.hour, k, next)}
                        />
                      ) : v == null ? (
                        "·"
                      ) : (
                        fmtInput(v, r)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={keys.length + 1}
                  className="px-2 py-3 text-center text-muted-foreground"
                >
                  No hourly values extracted.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NumberCellInput({
  value,
  range,
  onCommit,
}: {
  value: number | null;
  range: Range;
  onCommit: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={range.step ?? 1}
      defaultValue={fmtInput(value, range)}
      onBlur={(e) => {
        const next = parseNumber(e.currentTarget.value, range);
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      key={`${value ?? ""}`}
      className="w-14 rounded border border-transparent bg-transparent px-1 py-0.5 text-center tabular-nums focus:border-primary focus:bg-background focus:outline-none"
      placeholder="·"
      aria-label={`${range.label} value`}
    />
  );
}

function BalanceRow({
  extraction,
  lowConf,
  onEdit,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
  onEdit?: (v: number | null) => void;
}) {
  const v = extraction.balance_24h_ml;
  const uncertain = lowConf.has("balance_24h_ml");
  const sev: Severity =
    v == null ? "empty" : Math.abs(v) > 5000 ? "bad" : Math.abs(v) > 2000 ? "warn" : "ok";
  return (
    <div
      className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${
        uncertain ? "border-amber-500/50 bg-amber-500/5" : ""
      }`}
    >
      <span className="flex items-center gap-2">
        24h fluid balance
        <span className="text-xs text-muted-foreground">predicted ±2000 mL</span>
        {uncertain && <UncertainPill />}
      </span>
      {onEdit ? (
        <input
          type="number"
          inputMode="numeric"
          step={10}
          defaultValue={v == null ? "" : String(v)}
          onBlur={(e) => {
            const s = e.currentTarget.value.trim();
            const next = s === "" ? null : Math.round(Number(s));
            if (Number.isFinite(next as number) || next === null) {
              if (next !== v) onEdit(next);
            }
          }}
          key={`${v ?? ""}`}
          className={`w-28 rounded border bg-background px-2 py-0.5 text-right font-mono text-sm tabular-nums ${cellClass(sev)}`}
          placeholder="mL"
          aria-label="24 hour fluid balance"
        />
      ) : (
        <span className={`font-mono text-sm tabular-nums ${cellClass(sev)}`}>
          {v == null ? "—" : `${v > 0 ? "+" : ""}${v} mL`}
        </span>
      )}
    </div>
  );
}

function EditableListSection({
  title,
  items,
  onEditLeft,
  onEditRight,
  onEditTime,
  onRemove,
}: {
  title: string;
  items: Array<{
    idx: number;
    leftLabel: string;
    leftValue: string;
    rightLabel: string;
    rightValue: string;
    time: string;
    uncertain: boolean;
  }>;
  onEditLeft?: (idx: number, v: string) => void;
  onEditRight?: (idx: number, v: string) => void;
  onEditTime?: (idx: number, v: string) => void;
  onRemove?: (idx: number) => void;
}) {
  if (items.length === 0) return null;
  const editable = !!(onEditLeft || onEditRight);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title.toUpperCase()}</p>
      <ul className="divide-y rounded border">
        {items.map((it) => (
          <li
            key={it.idx}
            className={`grid gap-2 px-3 py-2 text-sm sm:grid-cols-[10rem_1fr_7rem_auto] ${
              it.uncertain ? "bg-amber-500/5" : ""
            }`}
          >
            <div className="flex items-center gap-1">
              {it.uncertain && <UncertainPill />}
              {onEditLeft ? (
                <input
                  className="w-full rounded border bg-background px-2 py-1 text-xs font-medium"
                  defaultValue={it.leftValue}
                  onBlur={(e) => {
                    if (e.currentTarget.value !== it.leftValue) onEditLeft(it.idx, e.currentTarget.value);
                  }}
                  aria-label={it.leftLabel}
                  placeholder={it.leftLabel}
                />
              ) : (
                <span className="font-medium">{it.leftValue}</span>
              )}
            </div>
            {onEditRight ? (
              <input
                className="w-full rounded border bg-background px-2 py-1 text-xs"
                defaultValue={it.rightValue}
                onBlur={(e) => {
                  if (e.currentTarget.value !== it.rightValue) onEditRight(it.idx, e.currentTarget.value);
                }}
                aria-label={it.rightLabel}
                placeholder={it.rightLabel}
              />
            ) : (
              <span className="text-muted-foreground">{it.rightValue || "—"}</span>
            )}
            {onEditTime ? (
              <input
                className="w-full rounded border bg-background px-2 py-1 font-mono text-xs tabular-nums"
                defaultValue={it.time}
                onBlur={(e) => {
                  if (e.currentTarget.value !== it.time) onEditTime(it.idx, e.currentTarget.value);
                }}
                aria-label="Result time"
                placeholder="HH:MM"
              />
            ) : (
              it.time && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{it.time}</span>
              )
            )}
            {editable && onRemove && (
              <button
                type="button"
                onClick={() => onRemove(it.idx)}
                className="justify-self-end rounded border px-2 py-1 text-[11px] text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                aria-label={`Remove ${title.toLowerCase()} entry`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ASSESSMENT_SYSTEMS = ["resp", "cvs", "renal", "neuro", "gastro", "haem", "micro", "other"] as const;

function AssessmentsBlock({
  extraction,
  lowConf,
  onEdit,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
  onEdit?: (system: string, text: string) => void;
}) {
  const assessments = extraction.assessments ?? {};
  // In edit mode show every system so the reviewer can add a missing one;
  // in read mode show only populated systems.
  const systems = onEdit
    ? [...ASSESSMENT_SYSTEMS]
    : ASSESSMENT_SYSTEMS.filter((s) => {
        const v = assessments[s as keyof typeof assessments];
        return typeof v === "string" && v.trim();
      });
  if (systems.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">SYSTEM ASSESSMENTS</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {systems.map((system) => {
          const text = (assessments[system as keyof typeof assessments] as string | null | undefined) ?? "";
          const uncertain = lowConf.has(`assessments.${system}`);
          return (
            <div
              key={system}
              className={`rounded border p-2 text-sm ${uncertain ? "bg-amber-500/5" : ""}`}
            >
              <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                {system}
                {uncertain && <UncertainPill />}
              </p>
              {onEdit ? (
                <textarea
                  className="min-h-[52px] w-full resize-y rounded border bg-background px-2 py-1 text-sm"
                  defaultValue={text}
                  onBlur={(e) => {
                    if (e.currentTarget.value !== text) onEdit(system, e.currentTarget.value);
                  }}
                  placeholder={`${system.toUpperCase()} assessment — leave blank if none`}
                  aria-label={`${system} assessment`}
                />
              ) : (
                <p className="whitespace-pre-wrap">{text}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UncertainPill() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" /> uncertain
    </span>
  );
}
