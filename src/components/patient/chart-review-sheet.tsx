import { AlertTriangle } from "lucide-react";
import type { ChartExtraction } from "@/lib/chart-extract.functions";

/**
 * Detailed pre-commit review of an extracted Radnor chart. Shows every value
 * the model returned, alongside physiological reference ranges typical for
 * an adult ICU patient. Out-of-range cells are highlighted so the reviewer
 * can spot OCR errors and clinical outliers before writing to the handover.
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
};

const HOURLY_RANGES: Record<string, Range> = {
  hr: { label: "HR", unit: "bpm", ok: [50, 130], hard: [20, 250] },
  sbp: { label: "SBP", unit: "mmHg", ok: [90, 160], hard: [40, 260] },
  dbp: { label: "DBP", unit: "mmHg", ok: [45, 100], hard: [20, 180] },
  map: { label: "MAP", unit: "mmHg", ok: [65, 110], hard: [30, 180] },
  cvp: { label: "CVP", unit: "mmHg", ok: [2, 15], hard: [-5, 30] },
  spo2: { label: "SpO₂", unit: "%", ok: [92, 100], hard: [40, 100] },
  etco2: { label: "EtCO₂", unit: "kPa", ok: [4, 6.5], hard: [1, 15] },
  rr: { label: "RR", unit: "/min", ok: [10, 25], hard: [0, 60] },
  temp: { label: "Temp", unit: "°C", ok: [36, 38], hard: [30, 42], precision: 1 },
  gcs: { label: "GCS", ok: [3, 15], hard: [3, 15] },
};

const VENT_RANGES: Record<string, Range> = {
  peep: { label: "PEEP", unit: "cmH₂O", ok: [4, 15], hard: [0, 30] },
  fio2: { label: "FiO₂", ok: [0.21, 0.8], hard: [0.21, 1], precision: 2 },
  p_support: { label: "PS", unit: "cmH₂O", ok: [5, 20], hard: [0, 40] },
  tv: { label: "Vt", unit: "mL", ok: [300, 650], hard: [50, 1200] },
  mv: { label: "MV", unit: "L/min", ok: [4, 12], hard: [0, 30], precision: 1 },
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

function fmt(v: number | null | undefined, r: Range): string {
  if (v == null || Number.isNaN(v)) return "·";
  if (r.precision != null) return v.toFixed(r.precision);
  return String(v);
}

function hasAny<T extends Record<string, unknown>>(rows: T[], keys: string[]): boolean {
  return rows.some((row) => keys.some((k) => row[k] != null && row[k] !== ""));
}

export function ChartReviewSheet({
  extraction,
  lowConf,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
}) {
  const rows = [...extraction.hourly].sort((a, b) => a.hour - b.hour);
  const vitalKeys = Object.keys(HOURLY_RANGES);
  const ventKeys = Object.keys(VENT_RANGES);
  const fluidKeys = Object.keys(FLUID_RANGES);

  const outCount = rows.reduce((n, row) => {
    for (const k of [...vitalKeys, ...ventKeys, ...fluidKeys]) {
      const r = HOURLY_RANGES[k] ?? VENT_RANGES[k] ?? FLUID_RANGES[k];
      const sev = classify(row[k as keyof typeof row] as number | null, r);
      if (sev === "warn" || sev === "bad") n += 1;
    }
    return n;
  }, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border bg-muted px-2 py-0.5">
          {rows.length} hourly row{rows.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-full border bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
          {outCount} value{outCount === 1 ? "" : "s"} outside predicted range
        </span>
        <span className="text-muted-foreground">
          Ranges are typical adult ICU ranges — amber = outside expected, rose = implausible.
        </span>
      </div>

      <VitalsTable rows={rows} keys={vitalKeys} ranges={HOURLY_RANGES} lowConf={lowConf} title="Vitals" />

      {hasAny(rows, ventKeys) && (
        <VitalsTable rows={rows} keys={ventKeys} ranges={VENT_RANGES} lowConf={lowConf} title="Ventilation" />
      )}

      {hasAny(rows, fluidKeys) && (
        <VitalsTable rows={rows} keys={fluidKeys} ranges={FLUID_RANGES} lowConf={lowConf} title="Fluids (per hour)" />
      )}

      <BalanceRow extraction={extraction} lowConf={lowConf} />

      <ListSection
        title="Investigations"
        items={extraction.investigations.map((i, idx) => ({
          key: `investigations[${idx}]`,
          left: i.category,
          right: i.findings ?? "—",
          time: i.result_at,
          uncertain:
            lowConf.has(`investigations[${idx}]`) ||
            lowConf.has(`investigations[${idx}].findings`) ||
            lowConf.has(`investigations[${idx}].category`),
        }))}
      />

      <ListSection
        title="Microbiology"
        items={extraction.microbiology.map((m, idx) => ({
          key: `microbiology[${idx}]`,
          left: m.specimen_type,
          right: m.findings ?? "—",
          time: m.result_at,
          uncertain:
            lowConf.has(`microbiology[${idx}]`) ||
            lowConf.has(`microbiology[${idx}].findings`) ||
            lowConf.has(`microbiology[${idx}].specimen_type`),
        }))}
      />

      <AssessmentsBlock extraction={extraction} lowConf={lowConf} />

      {extraction.notes && (
        <div className="rounded border p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            NURSING NOTES
            {lowConf.has("notes") && <UncertainPill />}
          </p>
          <p className="whitespace-pre-wrap">{extraction.notes}</p>
        </div>
      )}
    </div>
  );
}

function VitalsTable({
  rows,
  keys,
  ranges,
  lowConf,
  title,
}: {
  rows: ChartExtraction["hourly"];
  keys: string[];
  ranges: Record<string, Range>;
  lowConf: Set<string>;
  title: string;
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
                  return (
                    <td
                      key={k}
                      className={`px-2 py-1 text-center tabular-nums ${cellClass(sev)} ${
                        uncertain ? "outline outline-1 outline-amber-500/60" : ""
                      }`}
                      title={
                        uncertain
                          ? `OCR flagged uncertain · plausible ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""}`
                          : sev === "bad"
                            ? `Implausible — likely OCR error (expected ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""})`
                            : sev === "warn"
                              ? `Outside typical ${r.ok[0]}–${r.ok[1]}${r.unit ?? ""}`
                              : ""
                      }
                    >
                      {fmt(v, r)}
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

function BalanceRow({
  extraction,
  lowConf,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
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
      <span className={`font-mono text-sm tabular-nums ${cellClass(sev)}`}>
        {v == null ? "—" : `${v > 0 ? "+" : ""}${v} mL`}
      </span>
    </div>
  );
}

function ListSection({
  title,
  items,
}: {
  title: string;
  items: Array<{
    key: string;
    left: string;
    right: string;
    time?: string | null;
    uncertain: boolean;
  }>;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title.toUpperCase()}</p>
      <ul className="divide-y rounded border">
        {items.map((it) => (
          <li
            key={it.key}
            className={`flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm ${
              it.uncertain ? "bg-amber-500/5" : ""
            }`}
          >
            <span className="flex items-center gap-2 font-medium">
              {it.left}
              {it.uncertain && <UncertainPill />}
            </span>
            <span className="flex-1 pl-2 text-muted-foreground">{it.right}</span>
            {it.time && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {it.time}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssessmentsBlock({
  extraction,
  lowConf,
}: {
  extraction: ChartExtraction;
  lowConf: Set<string>;
}) {
  const entries = Object.entries(extraction.assessments ?? {}).filter(
    ([, v]) => typeof v === "string" && v.trim(),
  );
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">SYSTEM ASSESSMENTS</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map(([system, text]) => {
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
              <p className="whitespace-pre-wrap">{String(text)}</p>
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
