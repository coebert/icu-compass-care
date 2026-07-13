import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listPatientLines,
  addPatientLine,
  updatePatientLine,
  removePatientLine,
  deletePatientLine,
  LINE_TYPES,
  LINE_TYPE_LABEL,
  LINE_REVIEW_DAYS,
  type LineType,
} from "@/lib/lines.functions";
import { type PatientLine, daysInSitu } from "@/lib/lines";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Cable, Plus, Trash2, AlertTriangle } from "lucide-react";
import { fmtDate } from "@/lib/icu";

const today = () => new Date().toISOString().slice(0, 10);

function DwellBadge({ line }: { line: PatientLine }) {
  const days = daysInSitu(line);
  if (days === null) return null;
  const limit = LINE_REVIEW_DAYS[line.device_type as LineType];
  const overdue = limit != null && days >= limit;
  return (
    <Badge
      variant="outline"
      className={
        overdue
          ? "border-rose-500/40 text-rose-600 dark:text-rose-400"
          : "border-border text-muted-foreground"
      }
      title={limit != null ? `Review/replace by day ${limit}` : "No standard review interval"}
    >
      {overdue && <AlertTriangle className="mr-1 h-3 w-3" />}
      Day {days}
      {limit != null ? ` / ${limit}` : ""}
    </Badge>
  );
}

function LineRow({ line, patientId }: { line: PatientLine; patientId: string }) {
  const qc = useQueryClient();
  const removeFn = useServerFn(removePatientLine);
  const deleteFn = useServerFn(deletePatientLine);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient-lines", patientId] });

  const remove = useMutation({
    mutationFn: () => removeFn({ data: { id: line.id, removed_on: today() } }),
    onSuccess: () => {
      toast.success("Marked as removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: () => deleteFn({ data: { id: line.id } }),
    onSuccess: () => {
      toast.success("Deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removed = line.status === "removed";
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm ${
        removed ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {LINE_TYPE_LABEL[line.device_type as LineType] ?? line.device_type}
          </span>
          {line.site && <span className="text-muted-foreground">· {line.site}</span>}
          {line.laterality && <span className="text-muted-foreground">({line.laterality})</span>}
          {line.size && <span className="text-muted-foreground">· {line.size}</span>}
          {!removed && <DwellBadge line={line} />}
          {!line.inserted_in_unit && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              Inserted elsewhere
            </Badge>
          )}
          {removed && (
            <Badge variant="outline" className="text-muted-foreground">
              Removed {fmtDate(line.removed_on)}
            </Badge>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {line.inserted_on ? `Inserted ${fmtDate(line.inserted_on)}` : "Insertion date unknown"}
          {line.indication ? ` · ${line.indication}` : ""}
        </div>
        {line.notes && <div className="mt-1 text-xs text-muted-foreground">{line.notes}</div>}
      </div>
      <div className="flex items-center gap-1">
        {!removed && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Remove
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => del.mutate()}
          disabled={del.isPending}
          aria-label="Delete record"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function LinesCard({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listPatientLines);
  const addFn = useServerFn(addPatientLine);

  const { data: lines = [] } = useQuery({
    queryKey: ["patient-lines", patientId],
    queryFn: () => listFn({ data: { patientId } }) as Promise<PatientLine[]>,
  });

  const [adding, setAdding] = useState(false);
  const [deviceType, setDeviceType] = useState<LineType>("central_venous_catheter");
  const [site, setSite] = useState("");
  const [laterality, setLaterality] = useState("");
  const [size, setSize] = useState("");
  const [insertedOn, setInsertedOn] = useState(today());
  const [insertedInUnit, setInsertedInUnit] = useState(true);
  const [indication, setIndication] = useState("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setDeviceType("central_venous_catheter");
    setSite("");
    setLaterality("");
    setSize("");
    setInsertedOn(today());
    setInsertedInUnit(true);
    setIndication("");
    setNotes("");
    setAdding(false);
  };

  const add = useMutation({
    mutationFn: () =>
      addFn({
        data: {
          patient_id: patientId,
          device_type: deviceType,
          site: site || null,
          laterality: laterality || null,
          size: size || null,
          inserted_on: insertedOn || null,
          inserted_in_unit: insertedInUnit,
          indication: indication || null,
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      toast.success("Line/device added");
      qc.invalidateQueries({ queryKey: ["patient-lines", patientId] });
      reset();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const active = lines.filter((l) => l.status !== "removed");
  const removed = lines.filter((l) => l.status === "removed");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Cable className="h-4 w-4" /> Lines &amp; devices
          {active.length > 0 && (
            <Badge variant="outline" className="text-muted-foreground">
              {active.length} in situ
            </Badge>
          )}
        </CardTitle>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Device type</Label>
                <Select value={deviceType} onValueChange={(v) => setDeviceType(v as LineType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {LINE_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Insertion date</Label>
                <DatePicker
                  value={insertedOn}
                  onChange={setInsertedOn}
                />
              </div>
              <div className="space-y-1">
                <Label>Site</Label>
                <Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="e.g. Right IJ" />
              </div>
              <div className="space-y-1">
                <Label>Laterality</Label>
                <Input
                  value={laterality}
                  onChange={(e) => setLaterality(e.target.value)}
                  placeholder="Left / Right"
                />
              </div>
              <div className="space-y-1">
                <Label>Size / gauge</Label>
                <Input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 7Fr" />
              </div>
              <div className="space-y-1">
                <Label>Indication</Label>
                <Input
                  value={indication}
                  onChange={(e) => setIndication(e.target.value)}
                  placeholder="e.g. Vasopressors"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Optional notes"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={insertedInUnit}
                onCheckedChange={(v) => setInsertedInUnit(v === true)}
              />
              Inserted in this unit
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {lines.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">No lines or devices recorded.</p>
        )}

        {active.length > 0 && (
          <div className="space-y-2">
            {active.map((l) => (
              <LineRow key={l.id} line={l} patientId={patientId} />
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Removed
            </p>
            {removed.map((l) => (
              <LineRow key={l.id} line={l} patientId={patientId} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
