import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Investigation as DomainInvestigation } from "@/lib/domain-types";
import {
  listInvestigations,
  addInvestigation,
  updateInvestigation,
  deleteInvestigation,
} from "@/lib/investigations.functions";
import { INVESTIGATION_CATEGORIES, fmtDateTime } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Pencil, Trash2, Plus, FlaskConical } from "lucide-react";
import { toast } from "sonner";

type Investigation = DomainInvestigation & Record<string, any>;

function toDateTimeLocal(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 16);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function InvestigationsTab({
  patientId,
  focusId = null,
  focusSeq = 0,
}: {
  patientId: string;
  focusId?: string | null;
  focusSeq?: number;
}) {
  const qc = useQueryClient();
  const list = useServerFn(listInvestigations);
  const add = useServerFn(addInvestigation);
  const update = useServerFn(updateInvestigation);
  const del = useServerFn(deleteInvestigation);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [category, setCategory] = useState(INVESTIGATION_CATEGORIES[0]);
  const [findings, setFindings] = useState("");
  const [resultAt, setResultAt] = useState(() => toDateTimeLocal());

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => list({ data: { patientId } }) as Promise<Investigation[]>,
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    // wait for the list to render before scrolling
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightId(focusId);
        setTimeout(() => setHighlightId(null), 2000);
      }
    }, 50);
    return () => clearTimeout(t);
  }, [focusId, focusSeq, items.length]);

  const openAdd = () => {
    setEditingId(null);
    setCategory(INVESTIGATION_CATEGORIES[0]);
    setFindings("");
    setResultAt(toDateTimeLocal());
    setOpen(true);
  };

  const openEdit = (it: Investigation) => {
    setEditingId(it.id);
    setCategory(it.category ?? INVESTIGATION_CATEGORIES[0]);
    setFindings(it.findings ?? "");
    setResultAt(toDateTimeLocal(it.result_at));
    setOpen(true);
  };

  // A single success handler keeps the newest-per-category cards (here and on
  // the Overview tab, which share this query key) in sync immediately.
  const refreshAndClose = (message: string) => {
    qc.invalidateQueries({ queryKey: ["investigations", patientId] });
    setOpen(false);
    setEditingId(null);
    setFindings("");
    toast.success(message);
  };

  const addMut = useMutation({
    mutationFn: () =>
      add({
        data: {
          patient_id: patientId,
          category,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => refreshAndClose("Investigation saved"),
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  const updateMut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: editingId as string,
          category,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => refreshAndClose("Investigation updated"),
    onError: (e: Error) => toast.error("Could not update", { description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investigations", patientId] });
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error("Could not delete", { description: e.message }),
  });

  const saving = addMut.isPending || updateMut.isPending;

  // Most recent per category
  const mostRecent = useMemo(() => {
    const map = new Map<string, Investigation>();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, it);
    }
    return Array.from(map.values());
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Most recent results
        </h2>
        <Button size="sm" className="h-11 gap-1.5 sm:h-9" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add result
        </Button>
      </div>

      {mostRecent.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No investigations recorded.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mostRecent.map((it) => (
            <Card key={it.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <FlaskConical className="h-4 w-4 text-primary" /> Most recent {it.category}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="whitespace-pre-wrap text-sm">{it.findings}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Full history
        </h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries.</p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <Card key={it.id}>
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{it.category}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{it.findings}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit investigation"
                      onClick={() => openEdit(it)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete investigation"
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this investigation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes the {it.category} result from{" "}
                            {fmtDateTime(it.result_at)}.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => delMut.mutate(it.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit investigation result" : "Add investigation result"}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              (editingId ? updateMut : addMut).mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTIGATION_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date / time of result</Label>
              <DateTimePicker value={resultAt} onChange={setResultAt} />
            </div>
            <div className="space-y-1.5">
              <Label>Findings</Label>
              <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
