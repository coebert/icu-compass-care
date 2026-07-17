import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Camera, Loader2, Archive, RotateCcw, Lock, Maximize2, Minimize2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ensureChartDay,
  getChartDay,
  listChartDays,
  upsertHourlyCell,
  archiveChartDay,
  unarchiveChartDay,
  updateChartDay,
  type HourlyCell,
} from "@/lib/chart-days.functions";
import { ScanChartDialog } from "@/components/patient/chart-scanner";
import { fmtDateTime } from "@/lib/icu";


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

export function ChartTab({ patientId, initialDate }: { patientId: string; initialDate?: string }) {
  const [chartDate, setChartDate] = useState<string>(initialDate ?? todayISO());
  const [scanOpen, setScanOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [searchText, setSearchText] = useState<string>("");
  const showArchived = statusFilter !== "active";
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const qc = useQueryClient();

  const getDay = useServerFn(getChartDay);
  const listDays = useServerFn(listChartDays);
  const ensureDay = useServerFn(ensureChartDay);
  const upsertCell = useServerFn(upsertHourlyCell);
  const updateDay = useServerFn(updateChartDay);
  const archiveDay = useServerFn(archiveChartDay);
  const restoreDay = useServerFn(unarchiveChartDay);

  const dayQueryKey = ["chart-day", patientId, chartDate] as const;
  const daysQueryKey = ["chart-days", patientId, showArchived] as const;

  const dayQ = useQuery({
    queryKey: dayQueryKey,
    queryFn: () => getDay({ data: { patientId, chartDate } }),
  });
  const daysQ = useQuery({
    queryKey: daysQueryKey,
    queryFn: () => listDays({ data: { patientId, includeArchived: showArchived } }),
  });

  const ensureMut = useMutation({
    mutationFn: () => ensureDay({ data: { patientId, chartDate, source: "manual" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      qc.invalidateQueries({ queryKey: ["chart-days", patientId] });
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

  const archiveMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) => archiveDay({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      qc.invalidateQueries({ queryKey: ["chart-days", patientId] });
      toast.success("Chart archived. Access it via ‘Show archived’.");
      setArchiveOpen(false);
      setArchiveReason("");
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to archive chart"),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreDay({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dayQueryKey });
      qc.invalidateQueries({ queryKey: ["chart-days", patientId] });
      toast.success("Chart restored.");
    },
  });


  const hourly: HourlyRow[] = useMemo(() => {
    const rows = (dayQ.data?.hourly ?? []) as HourlyRow[];
    const byHour = new Map<number, HourlyRow>(rows.map((r) => [r.hour, r]));
    return HOURS.map((h) => byHour.get(h) ?? ({ hour: h } as HourlyRow));
  }, [dayQ.data]);

  const day = dayQ.data?.day ?? null;

  const chartBody = dayQ.isLoading ? (
    <p className="text-sm text-muted-foreground">Loading chart…</p>
  ) : !day ? (
    <p className="text-sm text-muted-foreground">
      No chart recorded for {chartDate}. Scan the paper chart or start a blank one.
    </p>
  ) : (
    <div className="space-y-6">
      {day.archived_at && (
        <div className="flex items-start gap-2 rounded border border-amber-400/60 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
          <Lock className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">Archived chart — read-only view</div>
            <div className="mt-0.5">
              Archived {fmtDateTime(day.archived_at)}
              {day.archive_reason ? ` · Reason: ${day.archive_reason}` : ""}
            </div>
            <div className="mt-0.5 opacity-80">
              Data is retained for medico-legal review. Use ‘Restore’ above to edit again.
            </div>
          </div>
        </div>
      )}
      {COL_GROUPS.map((group) => (
        <ChartGrid
          key={group.title}
          title={group.title}
          cols={group.cols}
          hourly={hourly}
          readOnly={!!day.archived_at}
          onSave={(hour, key, valueStr, col) => {
            if (day.archived_at) return;
            const trimmed = valueStr.trim();
            let next: string | number | null;
            if (col.type === "text") {
              next = trimmed === "" ? null : trimmed.slice(0, 200);
            } else {
              if (trimmed === "") {
                next = null;
              } else {
                const parsed = col.step
                  ? Number.parseFloat(trimmed)
                  : Number.parseInt(trimmed, 10);
                if (!Number.isFinite(parsed)) return;
                next = parsed;
              }
            }
            const prev = hourly.find((r) => r.hour === hour) ?? { hour };
            const patch = { ...prev, [key]: next } as HourlyCell & { hour: number };
            const { hour: _h, ...rest } = patch;
            void _h;
            cellMut.mutate({ chartDayId: day.id, hour, patch: rest as HourlyCell });
          }}
        />
      ))}

      <div>
        <Label htmlFor="chart-notes" className="text-xs">Nursing notes / summary</Label>
        <NotesEditor
          initial={day.notes ?? ""}
          disabled={notesMut.isPending || !!day.archived_at}
          onSave={(next) =>
            notesMut.mutate({ id: day.id, notes: next.trim() ? next : null })
          }
        />
      </div>
    </div>
  );

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
            {day && !day.archived_at && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setArchiveOpen(true)}
                className="gap-1"
                aria-label="Archive chart day"
              >
                <Archive className="h-4 w-4" /> Archive day
              </Button>
            )}
            {day?.archived_at && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => restoreMut.mutate(day.id)}
                disabled={restoreMut.isPending}
                className="gap-1"
              >
                <RotateCcw className="h-4 w-4" /> Restore
              </Button>
            )}
            {day && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFullscreen(true)}
                className="gap-1"
                aria-label="View chart fullscreen"
              >
                <Maximize2 className="h-4 w-4" /> Fullscreen
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>{chartBody}</CardContent>
      </Card>

      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:h-[100dvh] sm:max-w-none [&>button.absolute]:hidden"
        >
          <DialogHeader className="flex flex-row items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">
                Radnor 24-hour chart · {chartDate}
              </DialogTitle>
              <DialogDescription className="truncate text-xs">
                Fullscreen view — all edits save automatically.
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFullscreen(false)}
              className="gap-1"
              aria-label="Exit fullscreen"
            >
              <Minimize2 className="h-4 w-4" /> Exit
            </Button>
          </DialogHeader>
          <div className="flex-1 overflow-auto px-4 py-4 sm:px-6">{chartBody}</div>
        </DialogContent>
      </Dialog>


      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Chart archive</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                All past 24-hour charts are retained. Click a date to view. Archived charts are read-only.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">Status</Label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as "active" | "archived" | "all")}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="active">Active only</option>
                <option value="archived">Archived only</option>
                <option value="all">All</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">From</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">To</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1 sm:col-span-2 lg:col-span-1">
              <Label className="text-[10px] uppercase text-muted-foreground">Search</Label>
              <Input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Reason, source, date…"
                className="h-9"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 w-full"
                onClick={() => {
                  setStatusFilter("active");
                  setFromDate("");
                  setToDate("");
                  setSearchText("");
                }}
              >
                Reset
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {daysQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (() => {
            const q = searchText.trim().toLowerCase();
            const filtered = (daysQ.data ?? []).filter((d) => {
              if (statusFilter === "active" && d.archived_at) return false;
              if (statusFilter === "archived" && !d.archived_at) return false;
              if (fromDate && d.chart_date < fromDate) return false;
              if (toDate && d.chart_date > toDate) return false;
              if (q) {
                const hay = [
                  d.chart_date,
                  d.source ?? "",
                  d.archive_reason ?? "",
                  d.archived_at ? "archived" : "active",
                ].join(" ").toLowerCase();
                if (!hay.includes(q)) return false;
              }
              return true;
            });
            if (filtered.length === 0) {
              return (
                <p className="text-sm text-muted-foreground">
                  {(daysQ.data?.length ?? 0) === 0
                    ? "No chart days recorded yet."
                    : "No charts match the current filters."}
                </p>
              );
            }
            return (
              <>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Showing {filtered.length} of {daysQ.data?.length ?? 0} chart{(daysQ.data?.length ?? 0) === 1 ? "" : "s"}
                </p>
                <ul className="divide-y text-sm">
                  {filtered.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="text-left font-medium underline-offset-2 hover:underline"
                          onClick={() => setChartDate(d.chart_date)}
                        >
                          {d.chart_date}
                        </button>
                        {d.archived_at && (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <Archive className="h-3 w-3" /> Archived
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {d.source === "scan" ? "From scan" : "Manual"}
                          {d.balance_24h_ml != null ? ` · 24h bal ${d.balance_24h_ml} mL` : ""}
                        </span>
                        {d.archived_at && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => restoreMut.mutate(d.id)}
                            disabled={restoreMut.isPending}
                          >
                            <RotateCcw className="h-3 w-3" /> Restore
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}
        </CardContent>
      </Card>


      <ScanChartDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        patientId={patientId}
        chartDate={chartDate}
        onCommitted={() => {
          qc.invalidateQueries({ queryKey: dayQueryKey });
          qc.invalidateQueries({ queryKey: ["chart-days", patientId] });
        }}
      />

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this 24-hour chart?</DialogTitle>
            <DialogDescription>
              The chart will become read-only but remain permanently retained for review. Provide a
              short reason (e.g. superseded by rescan, entered in error, duplicate).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="archive-reason" className="text-xs">Reason (required, 3–500 chars)</Label>
            <Textarea
              id="archive-reason"
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Rescanned after correction; original retained for audit."
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!day) return;
                archiveMut.mutate({ id: day.id, reason: archiveReason.trim() });
              }}
              disabled={archiveMut.isPending || archiveReason.trim().length < 3}
              className="gap-2"
            >
              {archiveMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Archive chart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChartGrid({
  title,
  cols,
  hourly,
  onSave,
  readOnly = false,
}: {
  title: string;
  cols: ColDef[];
  hourly: HourlyRow[];
  onSave: (hour: number, key: keyof HourlyCell, value: string, col: ColDef) => void;
  readOnly?: boolean;
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
                  const raw = row[c.key] as number | string | null | undefined;
                  const isText = c.type === "text";
                  return (
                    <td key={String(c.key)} className="border-l p-0">
                      <input
                        type={isText ? "text" : "number"}
                        step={isText ? undefined : (c.step ?? "1")}
                        inputMode={isText ? undefined : c.step ? "decimal" : "numeric"}
                        maxLength={isText ? 200 : undefined}
                        readOnly={readOnly}
                        defaultValue={raw == null ? "" : String(raw)}
                        onBlur={(e) => {
                          if (readOnly) return;
                          const current = raw == null ? "" : String(raw);
                          if (e.currentTarget.value !== current) {
                            onSave(row.hour, c.key, e.currentTarget.value, c);
                          }
                        }}
                        className={`h-8 w-full bg-transparent px-2 outline-none focus:bg-accent/40 ${
                          isText ? "min-w-24" : "min-w-16 tabular-nums"
                        } ${readOnly ? "cursor-default" : ""}`}
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
