import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listObservations,
  addObservation,
  deleteObservation,
} from "@/lib/observations.functions";
import {
  type Observation,
  TREND_METRICS,
  type TrendKey,
  trendSeries,
  latestObservation,
  meanArterialPressure,
  fluidBalance24h,
  computeAcuity,
} from "@/lib/observations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Activity, Plus, Trash2, Droplets } from "lucide-react";
import { fmtDateTime } from "@/lib/icu";

export function AcuityBadge({
  latest,
  support,
  className,
}: {
  latest: Observation | null | undefined;
  support: { ventilated?: boolean | null; rrt?: boolean | null; vasoactive?: boolean | null };
  className?: string;
}) {
  const acuity = computeAcuity(latest, support);
  const tone =
    acuity.band === "high"
      ? "border-rose-500/40 text-rose-600 dark:text-rose-400"
      : acuity.band === "moderate"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`${tone} ${className ?? ""}`}
      title={acuity.supports.length ? acuity.supports.join(", ") : "No organ support recorded"}
    >
      {acuity.label} · {acuity.score}
    </Badge>
  );
}

function Sparkline({ points }: { points: { t: number; v: number }[] }) {
  if (points.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const w = 90;
  const h = 26;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p.v - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
    </svg>
  );
}

const NUM_FIELDS: { key: keyof Observation; label: string; step?: string }[] = [
  { key: "hr", label: "HR" },
  { key: "sbp", label: "SBP" },
  { key: "dbp", label: "DBP" },
  { key: "spo2", label: "SpO₂" },
  { key: "fio2", label: "FiO₂ (0–1)", step: "0.05" },
  { key: "rr", label: "RR" },
  { key: "temp", label: "Temp °C", step: "0.1" },
  { key: "gcs", label: "GCS" },
  { key: "lactate", label: "Lactate", step: "0.1" },
  { key: "peep", label: "PEEP" },
  { key: "vt", label: "Vt (mL)" },
  { key: "vasopressor_dose", label: "Pressor dose", step: "0.01" },
  { key: "urine_ml", label: "Urine (mL/h)" },
  { key: "fluid_in_ml", label: "Fluid in (mL)" },
  { key: "fluid_out_ml", label: "Fluid out (mL)" },
];

const INT_KEYS = new Set([
  "hr",
  "sbp",
  "dbp",
  "spo2",
  "rr",
  "gcs",
  "peep",
  "vt",
  "urine_ml",
  "fluid_in_ml",
  "fluid_out_ml",
]);

type FormState = Record<string, string>;

export function ObservationsCard({
  patientId,
  support,
}: {
  patientId: string;
  support: { ventilated?: boolean | null; rrt?: boolean | null; vasoactive?: boolean | null };
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listObservations);
  const addFn = useServerFn(addObservation);
  const delFn = useServerFn(deleteObservation);

  const [form, setForm] = useState<FormState>({});
  const [ventMode, setVentMode] = useState("");
  const [pressor, setPressor] = useState("");
  const [adding, setAdding] = useState(false);

  const { data: observations = [] } = useQuery({
    queryKey: ["observations", patientId],
    queryFn: () => listFn({ data: { patientId } }) as Promise<Observation[]>,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["observations", patientId] });
    qc.invalidateQueries({ queryKey: ["latest-observations"] });
  };

  const latest = useMemo(() => latestObservation(observations), [observations]);
  const balance = useMemo(() => fluidBalance24h(observations), [observations]);

  const addMut = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { patient_id: patientId };
      for (const [k, raw] of Object.entries(form)) {
        if (raw === "" || raw == null) continue;
        const n = Number(raw);
        if (Number.isNaN(n)) continue;
        payload[k] = INT_KEYS.has(k) ? Math.round(n) : n;
      }
      if (ventMode.trim()) payload.vent_mode = ventMode.trim();
      if (pressor.trim()) payload.vasopressor = pressor.trim();
      return addFn({ data: payload as never });
    },
    onSuccess: () => {
      invalidate();
      setForm({});
      setVentMode("");
      setPressor("");
      setAdding(false);
      toast.success("Observation recorded");
    },
    onError: (e: Error) => toast.error("Could not save observation", { description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error("Could not delete", { description: e.message }),
  });

  const hasEntry = Object.values(form).some((v) => v !== "") || ventMode.trim() || pressor.trim();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" /> Observations & trends
        </CardTitle>
        <div className="flex items-center gap-2">
          <AcuityBadge latest={latest} support={support} />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" /> Record obs
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {adding && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {NUM_FIELDS.map((f) => (
                <div key={f.key as string} className="space-y-1">
                  <Label className="text-xs">{f.label}</Label>
                  <Input
                    type="number"
                    step={f.step}
                    value={form[f.key as string] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.key as string]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="space-y-1">
                <Label className="text-xs">Vent mode</Label>
                <Input value={ventMode} onChange={(e) => setVentMode(e.target.value)} placeholder="e.g. SIMV" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Vasopressor</Label>
                <Input value={pressor} onChange={(e) => setPressor(e.target.value)} placeholder="e.g. Nor-adr" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!hasEntry || addMut.isPending} onClick={() => addMut.mutate()}>
                {addMut.isPending ? "Saving…" : "Save observation"}
              </Button>
            </div>
          </div>
        )}

        {/* Latest observation block */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Latest {latest ? `· ${fmtDateTime(latest.recorded_at)}` : ""}
          </p>
          {latest ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              <Stat label="HR" value={latest.hr} unit="bpm" />
              <Stat label="MAP" value={meanArterialPressure(latest)} unit="mmHg" />
              <Stat
                label="BP"
                value={latest.sbp != null && latest.dbp != null ? `${latest.sbp}/${latest.dbp}` : null}
              />
              <Stat label="SpO₂" value={latest.spo2} unit="%" />
              <Stat label="FiO₂" value={latest.fio2} />
              <Stat label="RR" value={latest.rr} />
              <Stat label="Temp" value={latest.temp} unit="°C" />
              <Stat label="GCS" value={latest.gcs} />
              <Stat label="Lactate" value={latest.lactate} />
              <Stat label="Urine" value={latest.urine_ml} unit="mL/h" />
              <Stat label="Vent" value={latest.vent_mode} />
              <Stat label="Pressor" value={latest.vasopressor} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No observations recorded yet.</p>
          )}
        </div>

        {/* Fluid balance */}
        <div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/50 p-3 text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <Droplets className="h-4 w-4" /> 24h fluid balance
          </span>
          <span className="text-muted-foreground">In {balance.inMl} mL</span>
          <span className="text-muted-foreground">Out {balance.outMl} mL</span>
          <span
            className={`font-semibold ${
              balance.balanceMl > 1500
                ? "text-amber-600 dark:text-amber-400"
                : balance.balanceMl < -1500
                  ? "text-amber-600 dark:text-amber-400"
                  : ""
            }`}
          >
            Net {balance.balanceMl >= 0 ? "+" : ""}
            {balance.balanceMl} mL
          </span>
        </div>

        {/* Trends */}
        {observations.length >= 2 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Trends</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {TREND_METRICS.map((m) => {
                const series = trendSeries(observations, m.key as TrendKey);
                const last = series[series.length - 1];
                return (
                  <div key={m.key} className="rounded-md border border-border p-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-medium">{m.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {last ? `${last.v} ${m.unit}` : "—"}
                      </span>
                    </div>
                    <Sparkline points={series} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent list */}
        {observations.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Recent entries</p>
            <ul className="space-y-1">
              {observations.slice(0, 8).map((o) => (
                <li
                  key={o.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
                >
                  <span className="w-28 shrink-0 text-muted-foreground">{fmtDateTime(o.recorded_at)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {[
                      o.hr != null && `HR ${o.hr}`,
                      (o.sbp != null && o.dbp != null && `BP ${o.sbp}/${o.dbp}`) ||
                        (meanArterialPressure(o) != null && `MAP ${meanArterialPressure(o)}`),
                      o.spo2 != null && `SpO₂ ${o.spo2}`,
                      o.lactate != null && `Lac ${o.lactate}`,
                      o.urine_ml != null && `UO ${o.urine_ml}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-destructive"
                    onClick={() => delMut.mutate(o.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
}) {
  const show = value != null && value !== "";
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">
        {show ? value : "—"}
        {show && unit ? <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">{unit}</span> : null}
      </p>
    </div>
  );
}
