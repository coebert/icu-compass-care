import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Camera, Loader2, Trash2 } from "lucide-react";
import {
  ensureChartDay,
  getChartDay,
  listChartDays,
  upsertHourlyCell,
  deleteChartDay,
  updateChartDay,
  type HourlyCell,
} from "@/lib/chart-days.functions";
import { ScanChartDialog } from "@/components/patient/chart-scanner";

type HourlyRow = HourlyCell & { hour: number };

const HOURS = Array.from({ length: 24 }, (_, i) => i);

// Column groups shown in the digital replica of the paper chart.
type ColDef = {
  key: keyof HourlyCell;
  label: string;
  step?: string;
  type?: "number" | "text";
};
const COL_GROUPS: { title: string; cols: ColDef[] }[] = [
  {
    title: "Vitals",
    cols: [
      { key: "hr", label: "HR" },
      { key: "sbp", label: "SBP" },
      { key: "dbp", label: "DBP" },
      { key: "map", label: "MAP" },
      { key: "cvp", label: "CVP" },
      { key: "spo2", label: "SpO₂" },
      { key: "etco2", label: "EtCO₂" },
      { key: "rr", label: "RR" },
      { key: "temp", label: "Temp", step: "0.1" },
      { key: "gcs", label: "GCS" },
    ],
  },
  {
    title: "Ventilation",
    cols: [
      { key: "vent_mode", label: "Mode", type: "text" },
      { key: "peep", label: "PEEP" },
      { key: "fio2", label: "FiO₂", step: "0.01" },
      { key: "p_support", label: "PS" },
      { key: "tv", label: "TV" },
      { key: "mv", label: "MV", step: "0.1" },
      { key: "peak_pressure", label: "Ppeak" },
    ],
  },
  {
    title: "Neuro / assessment",
    cols: [
      { key: "cam_icu", label: "CAM-ICU", type: "text" },
      { key: "pupils_l", label: "Pupils L", type: "text" },
      { key: "pupils_r", label: "Pupils R", type: "text" },
      { key: "bowels", label: "Bowels", type: "text" },
    ],
  },
  {
    title: "Fluid balance (mL)",
    cols: [
      { key: "intake_ml", label: "Intake" },
      { key: "flushes_ml", label: "Flushes" },
      { key: "ng_aspirate_ml", label: "NG asp" },
      { key: "ng_free_ml", label: "NG free" },
      { key: "urine_ml", label: "Urine" },
      { key: "target_removal_ml", label: "Target rem" },
      { key: "actual_removal_ml", label: "Removal" },
      { key: "hourly_balance_ml", label: "Hr bal" },
      { key: "cumulative_balance_ml", label: "Cum bal" },
    ],
  },
];


function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function ChartTab({ patientId }: { patientId: string }) {
  const [chartDate, setChartDate] = useState<string>(todayISO());
  const [scanOpen, setScanOpen] = useState(false);
  const qc = useQueryClient();

  const getDay = useServerFn(getChartDay);
  const listDays = useServerFn(listChartDays);
  const ensureDay = useServerFn(ensureChartDay);
  const upsertCell = useServerFn(upsertHourlyCell);
  const updateDay = useServerFn(updateChartDay);
  const removeDay = useServerFn(deleteChartDay);

  const dayQueryKey = ["chart-day", patientId, chartDate] as const;
  const daysQueryKey = ["chart-days", patientId] as const;

  const dayQ = useQuery({
    queryKey: dayQueryKey,
    queryFn: () => getDay({ data: { patientId, chartDate } }),
  });
  const daysQ = useQuery({
    queryKey: daysQueryKey,
    queryFn: () => listDays({ data: { patientId } }),
  });

  const ensureMut = useMutation({
    mutationFn: () => ensureDay({ data: { patientId, chartDate, source: "manual" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      qc.invalidateQueries({ queryKey: daysQueryKey });
    },
  });

  const cellMut = useMutation({
    mutationFn: (v: { chartDayId: string; hour: number; patch: HourlyCell }) =>
      upsertCell({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: dayQueryKey }),
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to save cell"),
  });

  const notesMut = useMutation({
    mutationFn: (v: { id: string; notes: string | null }) => updateDay({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      toast.success("Notes saved");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeDay({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      qc.invalidateQueries({ queryKey: daysQueryKey });
      toast.success("Chart day deleted");
    },
  });

  const hourly: HourlyRow[] = useMemo(() => {
    const rows = (dayQ.data?.hourly ?? []) as HourlyRow[];
    const byHour = new Map<number, HourlyRow>(rows.map((r) => [r.hour, r]));
    return HOURS.map((h) => byHour.get(h) ?? ({ hour: h } as HourlyRow));
  }, [dayQ.data]);

  const day = dayQ.data?.day ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Radnor 24-hour chart</CardTitle>
            <p className="text-xs text-muted-foreground">
              Digital replica of the paper chart. Data feeds through to observations,
              investigations and handover automatically.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="chart-date" className="text-xs">Chart date</Label>
              <Input
                id="chart-date"
                type="date"
                value={chartDate}
                onChange={(e) => setChartDate(e.target.value || todayISO())}
                className="w-40"
              />
            </div>
            <Button
              onClick={() => setScanOpen(true)}
              variant="default"
              className="gap-2"
            >
              <Camera className="h-4 w-4" /> Scan paper chart
            </Button>
            {!day && (
              <Button
                variant="outline"
                onClick={() => ensureMut.mutate()}
                disabled={ensureMut.isPending}
                className="gap-2"
              >
                {ensureMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Start blank chart
              </Button>
            )}
            {day && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this whole chart day?")) deleteMut.mutate(day.id);
                }}
                className="gap-1 text-destructive"
                aria-label="Delete chart day"
              >
                <Trash2 className="h-4 w-4" /> Delete day
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {dayQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading chart…</p>
          ) : !day ? (
            <p className="text-sm text-muted-foreground">
              No chart recorded for {chartDate}. Scan the paper chart or start a blank one.
            </p>
          ) : (
            <div className="space-y-6">
              {COL_GROUPS.map((group) => (
                <ChartGrid
                  key={group.title}
                  title={group.title}
                  cols={group.cols}
                  hourly={hourly}
                  onSave={(hour, key, valueStr, step) => {
                    const trimmed = valueStr.trim();
                    const num =
                      trimmed === "" ? null : step ? Number.parseFloat(trimmed) : Number.parseInt(trimmed, 10);
                    if (num !== null && !Number.isFinite(num)) return;
                    const prev = hourly.find((r) => r.hour === hour) ?? { hour };
                    const patch: HourlyCell = {
                      ...prev,
                      [key]: num,
                    } as HourlyCell;
                    // strip `hour` from patch
                    const { hour: _h, ...rest } = { ...patch, hour } as HourlyCell & { hour: number };
                    void _h;
                    cellMut.mutate({ chartDayId: day.id, hour, patch: rest as HourlyCell });
                  }}
                />
              ))}

              <div>
                <Label htmlFor="chart-notes" className="text-xs">Nursing notes / summary</Label>
                <NotesEditor
                  initial={day.notes ?? ""}
                  disabled={notesMut.isPending}
                  onSave={(next) =>
                    notesMut.mutate({ id: day.id, notes: next.trim() ? next : null })
                  }
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {(daysQ.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent chart days</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {(daysQ.data ?? []).map((d) => (
                <li key={d.id} className="flex items-center justify-between py-1.5">
                  <button
                    type="button"
                    className="text-left underline-offset-2 hover:underline"
                    onClick={() => setChartDate(d.chart_date)}
                  >
                    {d.chart_date}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {d.source === "scan" ? "From scan" : "Manual"}
                    {d.balance_24h_ml != null ? ` · 24h bal ${d.balance_24h_ml} mL` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ScanChartDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        patientId={patientId}
        chartDate={chartDate}
        onCommitted={() => {
          qc.invalidateQueries({ queryKey: dayQueryKey });
          qc.invalidateQueries({ queryKey: daysQueryKey });
        }}
      />
    </div>
  );
}

function ChartGrid({
  title,
  cols,
  hourly,
  onSave,
}: {
  title: string;
  cols: { key: keyof HourlyCell; label: string; step?: string }[];
  hourly: HourlyRow[];
  onSave: (hour: number, key: keyof HourlyCell, value: string, step: string | undefined) => void;
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="overflow-x-auto rounded border">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-10 border-r bg-muted/50 px-2 py-1 text-left font-medium">
                Hr
              </th>
              {cols.map((c) => (
                <th key={String(c.key)} className="border-l px-2 py-1 text-left font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hourly.map((row) => (
              <tr key={row.hour} className="odd:bg-muted/20">
                <td className="sticky left-0 z-10 border-r bg-background px-2 py-1 font-mono text-[11px] tabular-nums">
                  {`${row.hour}`.padStart(2, "0")}:00
                </td>
                {cols.map((c) => {
                  const raw = row[c.key] as number | null | undefined;
                  return (
                    <td key={String(c.key)} className="border-l p-0">
                      <input
                        type="number"
                        step={c.step ?? "1"}
                        inputMode={c.step ? "decimal" : "numeric"}
                        defaultValue={raw == null ? "" : String(raw)}
                        onBlur={(e) => {
                          const current = raw == null ? "" : String(raw);
                          if (e.currentTarget.value !== current) {
                            onSave(row.hour, c.key, e.currentTarget.value, c.step);
                          }
                        }}
                        className="h-8 w-full min-w-16 bg-transparent px-2 tabular-nums outline-none focus:bg-accent/40"
                        aria-label={`${c.label} at hour ${row.hour}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NotesEditor({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled?: boolean;
  onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="mt-1 space-y-2">
      <textarea
        id="chart-notes"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        className="w-full rounded border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || value === initial}
          onClick={() => onSave(value)}
        >
          Save notes
        </Button>
      </div>
    </div>
  );
}
