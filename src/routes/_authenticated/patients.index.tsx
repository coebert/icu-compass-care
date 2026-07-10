import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients, createPatient, updatePatient } from "@/lib/patients.functions";
import { PatientForm, emptyPatient, type PatientFormValues } from "@/components/PatientForm";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { STATUS_BADGE, STATUS_LABELS, fmtDate } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, HeartPulse, AlertTriangle, ClipboardList, FileDown, BedDouble } from "lucide-react";
import { toast } from "sonner";

import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";
// Radnor Critical Care Unit bed roster (admin-editable, shared with the bridge).
import { normalizeBed, checkBedEligibility, isSideRoom } from "@/lib/icu-beds";
import { listBeds, type Bed } from "@/lib/beds.functions";

export const Route = createFileRoute("/_authenticated/patients/")({
  component: PatientsBoard,
});

type Patient = Record<string, any>;

const DRAG_MIME = "application/x-patient";

// Escape user-supplied text before injecting it into the drag-ghost innerHTML.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}




// Build a human-readable location label. ICU patients are identified by
// location_type and a bed number (ward is usually blank for them), so we must
// not fall back to "No location" just because ward is empty.
function formatLocation(p: Patient): string {
  const bed = p.bed ? ` · Bed ${p.bed}` : "";
  if (p.location_type === "icu") return `ICU${bed}`;
  if (p.ward) return `${p.ward}${bed}`;
  if (p.bed) return `Bed ${p.bed}`;
  return "No location";
}

function PatientsBoard() {
  const qc = useQueryClient();
  const list = useServerFn(listPatients);
  const create = useServerFn(createPatient);
  const update = useServerFn(updatePatient);
  const beds = useServerFn(listBeds);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form, setForm] = useState<PatientFormValues>(emptyPatient());

  // Currently dragged patient (kept in a ref so drop handlers read the latest,
  // plus in state so the bed board can flag ineligible beds while dragging).
  const draggedRef = useRef<Patient | null>(null);
  const [draggedPatient, setDraggedPatient] = useState<Patient | null>(null);
  const dragging = draggedPatient !== null;
  // Holds the custom drag-image node so we can clean it up on drag end.
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // ---- Touch drag (tablets/phones) -------------------------------------
  // HTML5 drag events don't fire on touch, so we run a pointer-based drag:
  // long-press a card to pick it up, drag over a bed, lift to drop.
  const [touchOverBed, setTouchOverBed] = useState<string | null>(null);
  // Set true the moment a touch-drag ends so the card's click (which fires
  // after pointerup) doesn't navigate to the patient page.
  const suppressClickRef = useRef(false);
  const touchStateRef = useRef<{
    dragging: boolean;
    holdTimer: number | null;
    ghost: HTMLDivElement | null;
  } | null>(null);

  const { data: patients = [], isLoading } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });

  const { data: bedRoster = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => beds() as Promise<Bed[]>,
  });

  const createMut = useMutation({
    mutationFn: (v: PatientFormValues) => create({ data: v as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      setOpen(false);
      setForm(emptyPatient());
      toast.success("Patient added");
    },
    onError: (e: Error) => toast.error("Could not add patient", { description: e.message }),
  });

  // A snapshot of where each affected patient was BEFORE a move, used to undo.
  type BedSnapshot = { id: string; bed: string | null; location_type: string };

  const undoMut = useMutation({
    mutationFn: (previous: BedSnapshot[]) =>
      Promise.all(
        previous.map((p) =>
          update({
            data: {
              id: p.id,
              bed: p.bed,
              location_type: p.location_type,
            } as never,
          }),
        ),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Move undone", { description: "The bed assignment was restored." });
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.error("Could not undo move", { description: e.message });
    },
  });

  const moveMut = useMutation({
    mutationFn: ({ moves }: {
      moves: { id: string; bed: string; expected_updated_at?: string }[];
      summary?: string;
      previous?: BedSnapshot[];
    }) =>
      Promise.all(
        moves.map((m) =>
          update({
            data: {
              id: m.id,
              bed: m.bed,
              location_type: "icu",
              expected_updated_at: m.expected_updated_at,
            } as never,
          }),
        ),
      ),
    onSuccess: (_res, { summary, previous }) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Move saved", {
        description: summary ?? "The bed board has been updated.",
        ...(previous && previous.length > 0
          ? {
              action: {
                label: "Undo",
                onClick: () => undoMut.mutate(previous),
              },
              duration: 10000,
            }
          : {}),
      });
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.error("Could not move patient", { description: e.message });
    },
  });


  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return patients.filter((p) => {
      const active = p.status === "admitted" || p.status === "referred";
      if (!showArchived && !active) return false;
      if (showArchived && active) return false;
      if (!q) return true;
      return (
        p.full_name?.toLowerCase().includes(q) ||
        p.hospital_number?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q)
      );
    });
  }, [patients, search, showArchived]);

  const icu = filtered.filter((p) => p.location_type === "icu");
  const outliers = filtered.filter((p) => p.location_type === "outlier");

  // Map each ICU bed to the active patient(s) occupying it. Normally a bed has
  // at most one patient, but during transfers/data conflicts two rows can share
  // a bed number — we keep ALL of them so no patient is silently hidden.
  const bedOccupants = useMemo(() => {
    const map = new Map<string, Patient[]>();
    for (const p of icu) {
      const key = normalizeBed(p.bed);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [icu]);

  // Active ICU patients whose bed doesn't match a known bed slot.
  const icuUnassigned = icu.filter((p) => {
    const key = normalizeBed(p.bed);
    return !key || !bedRoster.some((b) => normalizeBed(b.label) === key);
  });

  function addToBed(bed: string) {
    setForm({ ...emptyPatient(), location_type: "icu", bed });
    setOpen(true);
  }

  function onDragStartPatient(p: Patient, e: React.DragEvent) {
    draggedRef.current = p;
    setDraggedPatient(p);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers require data to be set for the drag to initiate.
    try {
      e.dataTransfer.setData(DRAG_MIME, p.id);
    } catch {
      /* ignore */
    }
    // Build a styled "ghost" card that follows the cursor during the drag so
    // it's obvious which patient is being moved (instead of a plain text row).
    try {
      const ghost = document.createElement("div");
      ghost.style.cssText =
        "position:absolute;top:-9999px;left:-9999px;width:230px;pointer-events:none;" +
        "border-radius:12px;padding:12px 14px;background:hsl(var(--card));" +
        "color:hsl(var(--card-foreground));border:2px solid hsl(var(--primary));" +
        "box-shadow:0 12px 28px -8px rgba(0,0,0,0.45);font-family:inherit;";
      const from = p.location_type === "icu" && p.bed ? `Bed ${p.bed}` : "Unassigned";
      ghost.innerHTML =
        `<div style="font-weight:600;font-size:14px;line-height:1.2;">${escapeHtml(p.full_name ?? "Patient")}</div>` +
        `<div style="font-size:11px;opacity:0.7;margin-top:2px;">Moving from ${escapeHtml(from)}</div>` +
        (p.isolation_required
          ? `<div style="font-size:11px;color:hsl(var(--primary));margin-top:4px;">Isolation · side rooms only</div>`
          : "");
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
      e.dataTransfer.setDragImage(ghost, 20, 20);
    } catch {
      /* setDragImage unsupported — fall back to the default drag image */
    }
  }

  function onDragEndPatient() {
    draggedRef.current = null;
    setDraggedPatient(null);
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  }

  // Build a floating ghost card that tracks the finger during a touch drag.
  function makeTouchGhost(p: Patient): HTMLDivElement {
    const ghost = document.createElement("div");
    ghost.style.cssText =
      "position:fixed;z-index:60;top:0;left:0;width:220px;pointer-events:none;" +
      "transform:translate(-50%,-120%);border-radius:12px;padding:12px 14px;" +
      "background:hsl(var(--card));color:hsl(var(--card-foreground));" +
      "border:2px solid hsl(var(--primary));box-shadow:0 16px 32px -8px rgba(0,0,0,0.5);" +
      "font-family:inherit;opacity:0.95;";
    const from = p.location_type === "icu" && p.bed ? `Bed ${p.bed}` : "Unassigned";
    ghost.innerHTML =
      `<div style="font-weight:600;font-size:14px;line-height:1.2;">${escapeHtml(p.full_name ?? "Patient")}</div>` +
      `<div style="font-size:11px;opacity:0.7;margin-top:2px;">Moving from ${escapeHtml(from)}</div>` +
      (p.isolation_required
        ? `<div style="font-size:11px;color:hsl(var(--primary));margin-top:4px;">Isolation · side rooms only</div>`
        : "");
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveTouchGhost(x: number, y: number) {
    const g = touchStateRef.current?.ghost;
    if (g) {
      g.style.left = `${x}px`;
      g.style.top = `${y}px`;
    }
  }

  // Find the bed label under the given screen point (beds carry data-bed).
  function bedUnderPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const bedEl = el?.closest?.("[data-bed]") as HTMLElement | null;
    return bedEl?.dataset.bed ?? null;
  }

  function endTouchDrag() {
    const st = touchStateRef.current;
    if (st?.holdTimer) window.clearTimeout(st.holdTimer);
    if (st?.ghost) st.ghost.remove();
    touchStateRef.current = null;
    setTouchOverBed(null);
    window.removeEventListener("pointermove", onTouchMove);
    window.removeEventListener("pointerup", onTouchUp);
    window.removeEventListener("pointercancel", onTouchUp);
  }

  function onTouchMove(ev: PointerEvent) {
    const st = touchStateRef.current;
    if (!st?.dragging) return;
    ev.preventDefault();
    moveTouchGhost(ev.clientX, ev.clientY);
    setTouchOverBed(bedUnderPoint(ev.clientX, ev.clientY));
  }

  function onTouchUp(ev: PointerEvent) {
    const st = touchStateRef.current;
    const wasDragging = !!st?.dragging;
    const bed = wasDragging ? bedUnderPoint(ev.clientX, ev.clientY) : null;
    endTouchDrag();
    if (!wasDragging) return;
    suppressClickRef.current = true; // stop the trailing click from navigating
    if (bed) {
      dropOnBed(bed);
    } else {
      onDragEndPatient();
    }
  }

  // Start a candidate touch drag on pointerdown; only cards trigger this and
  // only for touch pointers (mouse keeps using native HTML5 drag).
  function onTouchDragStart(p: Patient, e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Long-press to pick up, so vertical scrolling and taps still work.
    const holdTimer = window.setTimeout(() => {
      const st = touchStateRef.current;
      if (!st) return;
      st.dragging = true;
      draggedRef.current = p;
      setDraggedPatient(p);
      st.ghost = makeTouchGhost(p);
      moveTouchGhost(startX, startY);
      try {
        navigator.vibrate?.(15);
      } catch {
        /* vibrate unsupported */
      }
    }, 200);
    touchStateRef.current = { dragging: false, holdTimer, ghost: null };
    window.addEventListener("pointermove", onTouchMove, { passive: false });
    window.addEventListener("pointerup", onTouchUp);
    window.addEventListener("pointercancel", onTouchUp);
  }






  // Drop a dragged patient into `targetBed`. If that bed is occupied, the two
  // patients swap places (the previous occupant takes the dragged one's old bed).
  // Drops that violate bed-eligibility rules are rejected with a clear error.
  function dropOnBed(targetBed: string) {
    const dragged = draggedRef.current;
    draggedRef.current = null;
    setDraggedPatient(null);
    if (!dragged) return;

    const targetKey = normalizeBed(targetBed);
    const occupants = bedOccupants.get(targetKey) ?? [];
    if (occupants.some((o) => o.id === dragged.id)) return; // dropped on its own bed

    const targetLabel = isSideRoom(targetBed, bedRoster) ? targetBed : `Bed ${targetBed}`;

    // Is the dragged patient allowed in the target bed?
    const eligibility = checkBedEligibility(dragged, targetBed, bedRoster);
    if (!eligibility.ok) {
      toast.error(`Can't move ${dragged.full_name ?? "patient"} to ${targetLabel}`, {
        description: eligibility.reason,
      });
      return;
    }

    // Only swap for a clean 1:1 move; if the bed already holds someone, add the
    // dragged patient there too rather than forcing a swap into a shared bed.
    const occupant = occupants.length === 1 ? occupants[0] : null;

    const moves: { id: string; bed: string; expected_updated_at?: string }[] = [
      { id: dragged.id, bed: targetBed, expected_updated_at: dragged.updated_at },
    ];
    // Snapshot the pre-move positions so the "Undo" action can restore them.
    const previous: BedSnapshot[] = [
      { id: dragged.id, bed: dragged.bed ?? null, location_type: dragged.location_type },
    ];

    let summary = `${dragged.full_name ?? "Patient"} moved to ${targetLabel}.`;

    if (occupant) {
      // Swap only makes sense when the dragged patient vacates a real ICU bed.
      const draggedHadBed = dragged.location_type === "icu" && normalizeBed(dragged.bed);
      if (draggedHadBed) {
        // The displaced occupant must also be eligible for the bed they'd take.
        const swapEligibility = checkBedEligibility(occupant, dragged.bed, bedRoster);
        if (!swapEligibility.ok) {
          toast.error(`Can't swap with ${occupant.full_name ?? "patient"}`, {
            description: swapEligibility.reason,
          });
          return;
        }
        moves.push({ id: occupant.id, bed: dragged.bed, expected_updated_at: occupant.updated_at });
        previous.push({ id: occupant.id, bed: occupant.bed ?? null, location_type: occupant.location_type });
        const fromLabel = isSideRoom(dragged.bed, bedRoster) ? dragged.bed : `Bed ${dragged.bed}`;
        summary = `${dragged.full_name ?? "Patient"} and ${occupant.full_name ?? "patient"} swapped between ${fromLabel} and ${targetLabel}.`;
      }
    }

    moveMut.mutate({ moves, summary, previous });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Patient board</h1>
          <p className="text-sm text-muted-foreground">
            {showArchived ? "Discharged & deceased records" : "Current ICU patients and outlying referrals"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-11 w-full pl-9 sm:h-10"
              placeholder="Search initials or hospital no.…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant={showArchived ? "secondary" : "outline"} className="h-11 flex-1 sm:h-10 sm:flex-none" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Show current" : "Archive"}
          </Button>
          <Button
            variant="outline"
            className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none"
            disabled={filtered.length === 0}
            onClick={() => setPreviewOpen(true)}
          >
            <FileDown className="h-4 w-4" /> Preview PDF
          </Button>
          <Button onClick={() => setOpen(true)} className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none">
            <Plus className="h-4 w-4" /> Add patient
          </Button>
        </div>

      </div>




      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : showArchived ? (
        filtered.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No patients to show.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            <Section title="ICU" icon={HeartPulse} patients={icu} />
            <Section title="Outlying wards / referrals" icon={ClipboardList} patients={outliers} />
          </div>
        )
      ) : (
        <div className="space-y-8">
          <BedBoard
            roster={bedRoster}
            bedOccupants={bedOccupants}
            unassigned={icuUnassigned}
            onAddToBed={addToBed}
            dragging={dragging}
            draggedPatient={draggedPatient}
            onDragStartPatient={onDragStartPatient}
            onDragEndPatient={onDragEndPatient}
            onDropOnBed={dropOnBed}
          />
          <Section
            title="Outlying wards / referrals"
            icon={ClipboardList}
            patients={outliers}
            onDragStartPatient={onDragStartPatient}
            onDragEndPatient={onDragEndPatient}
          />
        </div>
      )}

      <HandoverPreviewModal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        patients={filtered}
        title={showArchived ? "ICU Handover — Archived" : "ICU Handover Sheet"}
      />



      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add patient</DialogTitle>
          </DialogHeader>
          <PatientForm
            values={form}
            onChange={setForm}
            onSubmit={() => createMut.mutate(form)}
            onCancel={() => setOpen(false)}
            submitting={createMut.isPending}
            submitLabel="Add patient"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PatientCardBody({ p, bedLabel }: { p: Patient; bedLabel?: string }) {
  return (
    <CardContent className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <PatientName patient={p} showAge />
          <p className="truncate text-xs text-muted-foreground">
            {bedLabel ?? formatLocation(p)}
          </p>
        </div>
        <Badge className={`${STATUS_BADGE[p.status]} shrink-0`} variant="secondary">
          {STATUS_LABELS[p.status]}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {p.dnacpr_decision && (
          <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3 w-3" /> DNACPR
          </Badge>
        )}
        {p.tep_in_place && <Badge variant="outline">TEP</Badge>}
        {p.isolation_required && (
          <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
            <BedDouble className="h-3 w-3" /> Isolation
          </Badge>
        )}
      </div>
      {p.outstanding_tasks && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Tasks: </span>
          {p.outstanding_tasks}
        </p>
      )}
      <PatientMetaLine
        patient={p}
        showAge={false}
        trailing={[`Adm ${fmtDate(p.admission_date)}`]}
        className="text-[11px]"
      />
    </CardContent>
  );
}

// A patient card that can be dragged onto a bed. Click still opens the detail
// page; only a real drag gesture starts a move.
function DraggablePatientLink({
  p,
  children,
  onDragStartPatient,
  onDragEndPatient,
}: {
  p: Patient;
  children: React.ReactNode;
  onDragStartPatient?: (p: Patient, e: React.DragEvent) => void;
  onDragEndPatient?: () => void;
}) {
  return (
    <Link
      to="/patients/$patientId"
      params={{ patientId: p.id }}
      draggable={!!onDragStartPatient}
      onDragStart={(e) => onDragStartPatient?.(p, e)}
      onDragEnd={() => onDragEndPatient?.()}
      className="block cursor-grab active:cursor-grabbing"
    >
      {children}
    </Link>
  );
}

function BedBoard({
  roster,
  bedOccupants,
  unassigned,
  onAddToBed,
  dragging,
  draggedPatient,
  onDragStartPatient,
  onDragEndPatient,
  onDropOnBed,
}: {
  roster: Bed[];
  bedOccupants: Map<string, Patient[]>;
  unassigned: Patient[];
  onAddToBed: (bed: string) => void;
  dragging: boolean;
  draggedPatient: Patient | null;
  onDragStartPatient: (p: Patient, e: React.DragEvent) => void;
  onDragEndPatient: () => void;
  onDropOnBed: (bed: string) => void;
}) {
  const occupied = roster.filter((b) => (bedOccupants.get(normalizeBed(b.label))?.length ?? 0) > 0).length;
  const [overBed, setOverBed] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <BedDouble className="h-4 w-4" /> Radnor Critical Care — Bed board
        <span className="text-xs">({occupied}/{roster.length} occupied)</span>
      </h2>
      {dragging && (
        <p className="text-xs text-primary">
          Drop the card on a bed to move the patient there.
          {draggedPatient?.isolation_required && " This patient requires isolation — side rooms only."}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {roster.map((slot) => {
          const bed = slot.label;
          const label = slot.is_side_room ? bed : `Bed ${bed}`;
          const occupants = bedOccupants.get(normalizeBed(bed)) ?? [];
          const isOver = overBed === bed;
          // While dragging, decide whether this bed can accept the patient so we
          // can flag ineligible beds and refuse the drop with a "no-drop" cursor.
          const ineligible = Boolean(
            draggedPatient && !checkBedEligibility(draggedPatient, bed, roster).ok,
          );
          const isOwnBed = Boolean(
            draggedPatient && occupants.some((o) => o.id === draggedPatient.id),
          );
          // A valid drop target: dragging an eligible patient onto a bed that
          // isn't the one they already occupy. Highlighted persistently so all
          // legal targets are visible at a glance, not just the hovered one.
          const validTarget = dragging && !ineligible && !isOwnBed;
          const dropHandlers = {
            onDragOver: (e: React.DragEvent) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = ineligible ? "none" : "move";
              if (overBed !== bed) setOverBed(bed);
            },
            onDragLeave: () => setOverBed((b) => (b === bed ? null : b)),
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              setOverBed(null);
              onDropOnBed(bed);
            },
          };
          const overRing = ineligible
            ? "border-destructive ring-2 ring-destructive/40"
            : "border-primary ring-2 ring-primary/40";
          // Steady highlight applied to every legal target during a drag.
          const validRing = validTarget && !isOver ? "ring-2 ring-primary/30 ring-offset-1 ring-offset-background" : "";
          if (occupants.length > 0) {
            return (
              <div key={slot.id} {...dropHandlers} className={`space-y-2 rounded-lg transition-shadow ${validRing}`}>
                {occupants.length > 1 && (
                  <p className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" /> {occupants.length} patients in {label}
                  </p>
                )}
                {occupants.map((p) => (
                  <DraggablePatientLink
                    key={p.id}
                    p={p}
                    onDragStartPatient={onDragStartPatient}
                    onDragEndPatient={onDragEndPatient}
                  >
                    <Card className={`h-full transition-colors hover:border-primary/50 ${isOver ? overRing : ""}`}>
                      <div className="border-b bg-muted/40 px-4 py-1.5 text-xs font-semibold">
                        {label}
                      </div>
                      <PatientCardBody p={p} bedLabel={slot.is_side_room ? "Side room" : undefined} />
                    </Card>
                  </DraggablePatientLink>
                ))}
              </div>
            );
          }
          return (
            <button
              key={slot.id}
              type="button"
              onClick={() => onAddToBed(bed)}
              {...dropHandlers}
              className={`group flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/20 p-4 text-center transition-colors hover:border-primary hover:bg-primary/5 ${dragging && ineligible ? "opacity-50" : ""} ${validTarget && !isOver ? "border-primary/60 bg-primary/5 ring-2 ring-primary/30 ring-offset-1 ring-offset-background" : ""} ${isOver ? (ineligible ? "border-destructive bg-destructive/10 ring-2 ring-destructive/40" : "border-primary bg-primary/10 ring-2 ring-primary/40") : ""}`}
            >
              <span className="text-xs font-semibold text-muted-foreground">{label}</span>
              <span className="flex items-center gap-1 text-sm text-muted-foreground group-hover:text-primary">
                <Plus className="h-4 w-4" /> Empty
              </span>
              <span className="text-[11px] text-muted-foreground">
                {dragging ? (ineligible ? "Not eligible" : "Drop here") : "Tap to admit"}
              </span>
            </button>
          );
        })}
      </div>

      {unassigned.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            ICU · no bed assigned ({unassigned.length})
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {unassigned.map((p) => (
              <DraggablePatientLink
                key={p.id}
                p={p}
                onDragStartPatient={onDragStartPatient}
                onDragEndPatient={onDragEndPatient}
              >
                <Card className="h-full transition-colors hover:border-primary/50">
                  <PatientCardBody p={p} />
                </Card>
              </DraggablePatientLink>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  patients,
  onDragStartPatient,
  onDragEndPatient,
}: {
  title: string;
  icon: React.ElementType;
  patients: Patient[];
  onDragStartPatient?: (p: Patient, e: React.DragEvent) => void;
  onDragEndPatient?: () => void;
}) {
  if (patients.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-4 w-4" /> {title} <span className="text-xs">({patients.length})</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {patients.map((p) => (
          <DraggablePatientLink
            key={p.id}
            p={p}
            onDragStartPatient={onDragStartPatient}
            onDragEndPatient={onDragEndPatient}
          >
            <Card className="h-full transition-colors hover:border-primary/50">
              <PatientCardBody p={p} />
            </Card>
          </DraggablePatientLink>
        ))}
      </div>
    </div>
  );
}
