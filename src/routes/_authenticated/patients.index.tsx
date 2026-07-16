import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients, createPatient, updatePatient } from "@/lib/patients.functions";
import { PatientForm, emptyPatient, type PatientFormValues } from "@/components/PatientForm";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { PreviousAdmissionBanner } from "@/components/PreviousAdmissionBanner";

import { STATUS_BADGE, STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Plus, Search, HeartPulse, AlertTriangle, ClipboardList, FileDown, BedDouble, Maximize2, Clock, ClipboardCheck, DoorClosed, Home, RefreshCw, Undo2, X as XIcon } from "lucide-react";
import { deriveSafetyFlags, parseAllergies } from "@/lib/patient-safety";
import { listLatestObservations } from "@/lib/observations.functions";
import { listLatestKeyInvestigations } from "@/lib/investigations.functions";
import { type Observation } from "@/lib/observations";
import { AcuityBadge } from "@/components/patient/observations-card";
import { toast } from "sonner";

// Supplies the latest observation per patient down to the deeply-nested cards.
const AcuityContext = createContext<Map<string, Observation>>(new Map());

// Latest key investigation per patient, keyed by "<patientId>::<category>".
type KeyInvestigation = { category: string; findings: string; result_at: string };
const KeyInvestigationsContext = createContext<Map<string, KeyInvestigation>>(new Map());

import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";
// Radnor Critical Care Unit bed roster (admin-editable, shared with the bridge).
import { normalizeBed, checkBedEligibility, isSideRoom } from "@/lib/icu-beds";
import { listBeds, type Bed } from "@/lib/beds.functions";
import { MoveToBedMenu } from "@/components/patient/move-to-bed-menu";


import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";

const patientsBoardSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  sex: fallback(z.string(), "all").default("all"),
  archived: fallback(z.boolean(), false).default(false),
  density: fallback(z.string(), "detailed").default("detailed"),
  // Optional shortcut applied from the Unit dashboard stat cards.
  preset: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/patients/")({
  component: PatientsBoard,
  validateSearch: zodValidator(patientsBoardSearchSchema),
});

import type { Patient as DomainPatient } from "@/lib/domain-types";
type Patient = DomainPatient & Record<string, any>;


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
  const urlSearch = Route.useSearch();
  const navigate = useNavigate();
  type BoardSearch = z.infer<typeof patientsBoardSearchSchema>;
  const updateBoardSearch = (patch: Partial<BoardSearch>) =>
    navigate({
      to: "/patients",
      search: (prev: BoardSearch) => ({ ...prev, ...patch }),
      replace: true,
    });
  const search = urlSearch.q;
  const setSearch = (v: string) => updateBoardSearch({ q: v });
  const SEX_OPTS = ["all", "female", "male", "other", "unknown"] as const;
  type SexFilter = (typeof SEX_OPTS)[number];
  const sexFilter: SexFilter = (SEX_OPTS as readonly string[]).includes(urlSearch.sex)
    ? (urlSearch.sex as SexFilter)
    : "all";
  const setSexFilter = (v: SexFilter) => updateBoardSearch({ sex: v });
  const showArchived = urlSearch.archived;
  const setShowArchived = (fn: (prev: boolean) => boolean) =>
    updateBoardSearch({ archived: fn(showArchived) });
  const density: "compact" | "detailed" = urlSearch.density === "compact" ? "compact" : "detailed";
  const setDensity = (v: "compact" | "detailed") => updateBoardSearch({ density: v });
  const PRESETS = {
    vent: { label: "Ventilated / resp support", test: (p: Patient) =>
      p.airway_type === "ett" || p.airway_type === "tracheostomy" || (Array.isArray(p.resp_support) && p.resp_support.length > 0) },
    vasoactive: { label: "On vasoactives", test: (p: Patient) => Array.isArray(p.vasoactive_agents) && p.vasoactive_agents.length > 0 },
    rrt: { label: "On RRT", test: (p: Patient) => p.renal_rrt === true },
    isolation: { label: "Isolation", test: (p: Patient) => p.isolation_required === true },
    noresus: { label: "No resus/TEP decision", test: (p: Patient) => !p.dnacpr_decision && !p.tep_in_place },
    allergy: { label: "Recorded allergies", test: (p: Patient) => parseAllergies(p.allergies).length > 0 },
    stale: { label: "Records not updated recently", test: (p: Patient) => Boolean(deriveSafetyFlags(p).stale) },
  } as const;
  type PresetKey = keyof typeof PRESETS;
  const preset: PresetKey | "" = (urlSearch.preset in PRESETS ? (urlSearch.preset as PresetKey) : "");
  const clearPreset = () => updateBoardSearch({ preset: "" });
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
  type RecentMove = {
    key: string;
    at: number;
    label: string;
    previous: { id: string; bed: string | null; location_type: string }[];
  };
  const [recentMoves, setRecentMoves] = useState<RecentMove[]>([]);
  const pushRecentMove = (m: RecentMove) =>
    setRecentMoves((prev) => [m, ...prev.filter((r) => r.key !== m.key)].slice(0, 3));
  const clearRecentMove = (key: string) =>
    setRecentMoves((prev) => prev.filter((r) => r.key !== key));
  // Set true the moment a touch-drag ends so the card's click (which fires
  // after pointerup) doesn't navigate to the patient page.
  const suppressClickRef = useRef(false);
  const touchStateRef = useRef<{
    dragging: boolean;
    holdTimer: number | null;
    ghost: HTMLDivElement | null;
    startX: number;
    startY: number;
  } | null>(null);

  const { data: patients = [], isLoading } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });

  const { data: bedRoster = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => beds() as Promise<Bed[]>,
  });

  const latestObsFn = useServerFn(listLatestObservations);
  const { data: latestObs = [] } = useQuery({
    queryKey: ["latest-observations"],
    queryFn: () => latestObsFn() as Promise<Observation[]>,
  });
  const obsByPatient = useMemo(() => {
    const m = new Map<string, Observation>();
    for (const o of latestObs) m.set(o.patient_id, o);
    return m;
  }, [latestObs]);

  const latestKeyInvFn = useServerFn(listLatestKeyInvestigations);
  const { data: latestKeyInv = [] } = useQuery({
    queryKey: ["latest-key-investigations"],
    queryFn: () =>
      latestKeyInvFn() as Promise<
        { patient_id: string; category: string; findings: string; result_at: string }[]
      >,
  });
  const keyInvByPatient = useMemo(() => {
    const m = new Map<string, KeyInvestigation>();
    for (const r of latestKeyInv) {
      m.set(`${r.patient_id}::${r.category}`, {
        category: r.category,
        findings: r.findings,
        result_at: r.result_at,
      });
    }
    return m;
  }, [latestKeyInv]);


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
      if (previous && previous.length > 0) {
        pushRecentMove({
          key: `${previous.map((p) => p.id).join(",")}-${Date.now()}`,
          at: Date.now(),
          label: summary ?? "Bed move",
          previous,
        });
      }
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.error("Could not move patient", { description: e.message });
    },
  });


  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return patients.filter((p) => {
      const matches =
        !q ||
        p.full_name?.toLowerCase().includes(q) ||
        p.hospital_number?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q);
      if (!matches) return false;
      if (sexFilter !== "all" && p.sex !== sexFilter) return false;
      // While searching, span every record (current AND discharged/died) so a
      // patient can always be found by hospital number after discharge.
      if (q) return true;
      const active = p.status === "admitted" || p.status === "referred";
      if (!(showArchived ? !active : active)) return false;
      if (preset && !PRESETS[preset].test(p)) return false;
      return true;
    });
  }, [patients, search, sexFilter, showArchived, preset]);


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
    if (!st) return;
    if (!st.dragging) {
      // Still in the long-press window: if the finger travels far, treat it as
      // a scroll/tap and abandon the pending pick-up.
      if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) > 12) {
        endTouchDrag();
      }
      return;
    }
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
    touchStateRef.current = { dragging: false, holdTimer, ghost: null, startX, startY };
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

    const targetLabel = isSideRoom(targetBed, bedRoster) ? `Side room ${targetBed}` : `Bed ${targetBed}`;

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
        const swapEligibility = checkBedEligibility(occupant, dragged.bed!, bedRoster);
        if (!swapEligibility.ok) {
          toast.error(`Can't swap with ${occupant.full_name ?? "patient"}`, {
            description: swapEligibility.reason,
          });
          return;
        }
        moves.push({ id: occupant.id, bed: dragged.bed!, expected_updated_at: occupant.updated_at });
        previous.push({ id: occupant.id, bed: occupant.bed ?? null, location_type: occupant.location_type });
        const fromLabel = isSideRoom(dragged.bed, bedRoster) ? `Side room ${dragged.bed}` : `Bed ${dragged.bed}`;
        summary = `${dragged.full_name ?? "Patient"} and ${occupant.full_name ?? "patient"} swapped between ${fromLabel} and ${targetLabel}.`;
      }
    }

    moveMut.mutate({ moves, summary, previous });
  }

  return (
    <AcuityContext.Provider value={obsByPatient}>
    <KeyInvestigationsContext.Provider value={keyInvByPatient}>
    <div className="group/board space-y-6" data-density={density}>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Patient board</h1>
          <p className="text-sm text-muted-foreground">
            {showArchived ? "Discharged & deceased records" : "Current ICU patients and outlying referrals"}
          </p>
          {preset && (
            <button
              type="button"
              onClick={clearPreset}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/15"
              aria-label={`Clear filter: ${PRESETS[preset].label}`}
            >
              Filter: {PRESETS[preset].label} · clear ✕
            </button>
          )}
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
          <Select value={sexFilter} onValueChange={(v) => setSexFilter(v as SexFilter)}>
            <SelectTrigger className="h-11 w-full sm:h-10 sm:w-36" aria-label="Filter by sex">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sexes</SelectItem>
              <SelectItem value="female">Female</SelectItem>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="other">Other</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="h-11 gap-1.5 sm:h-10"
            onClick={() => setDensity(density === "compact" ? "detailed" : "compact")}
            aria-label={density === "compact" ? "Show detailed cards" : "Show compact cards"}
            title={density === "compact" ? "Detailed cards" : "Compact cards"}
          >
            {density === "compact" ? "Detailed" : "Compact"}
          </Button>
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
          <Button
            asChild
            variant="outline"
            className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none"
            disabled={filtered.length === 0}
          >
            <Link to="/patients/handover-preview" search={{ archived: showArchived }}>
              <Maximize2 className="h-4 w-4" /> Full preview
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none"
          >
            <Link to="/patients/handover-mode">
              <ClipboardCheck className="h-4 w-4" /> Handover mode
            </Link>
          </Button>
          <Button onClick={() => setOpen(true)} className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none">
            <Plus className="h-4 w-4" /> Add patient
          </Button>
        </div>

      </div>




      {isLoading ? (
        <ListSkeleton rows={5} />
      ) : search.trim() ? (

        filtered.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No patients match “{search.trim()}”. Search spans current and discharged/deceased records.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {filtered.length} result{filtered.length === 1 ? "" : "s"} across current and archived records
            </p>
            <Section title="ICU" icon={HeartPulse} patients={icu} />
            <Section title="Outlying wards / referrals" icon={ClipboardList} patients={outliers} />
          </div>
        )
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
          <RecentMovesStrip
            moves={recentMoves}
            onRevert={(m) => {
              undoMut.mutate(m.previous);
              clearRecentMove(m.key);
            }}
            onDismiss={clearRecentMove}
          />
          <BedBoard
            roster={bedRoster}
            bedOccupants={bedOccupants}
            unassigned={icuUnassigned}
            onAddToBed={addToBed}
            dragging={dragging}
            draggedPatient={draggedPatient}
            touchOverBed={touchOverBed}
            onDragStartPatient={onDragStartPatient}
            onDragEndPatient={onDragEndPatient}
            onTouchDragStart={onTouchDragStart}
            suppressClickRef={suppressClickRef}
            onDropOnBed={dropOnBed}
          />
          <Section
            title="Outlying wards / referrals"
            icon={ClipboardList}
            patients={outliers}
            onDragStartPatient={onDragStartPatient}
            onDragEndPatient={onDragEndPatient}
            onTouchDragStart={onTouchDragStart}
            suppressClickRef={suppressClickRef}
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
          <div className="mb-4">
            <PreviousAdmissionBanner
              values={form}
              onApply={(patch) => setForm((f) => ({ ...f, ...patch }))}
            />
          </div>
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
    </KeyInvestigationsContext.Provider>
    </AcuityContext.Provider>
  );
}

// Format elapsed time since the patient was marked "ready for the ward".
// Ticks live so the timer updates without a network round-trip.
function useElapsedSince(iso: string | null | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    if (!iso) return;
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, [iso]);
  if (!iso) return "";
  const ms = Math.max(0, now - new Date(iso).getTime());
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// Clickable "Wardable" pill. Marking a patient as ready-for-ward stamps a
// server-side timestamp and starts an elapsed timer — the difference between
// this and actual discharge is the data we're trying to gather.
function WardableToggle({ p }: { p: Patient }) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  const isOn = p.wardable === true;
  const elapsed = useElapsedSince(isOn ? p.wardable_at : null);
  const [syncState, setSyncState] = useState<"idle" | "pending" | "failed">("idle");

  // Attempt the local save + treat it as the trigger to publish the new
  // wardable state to the partner app. Because the partner pulls via the
  // bridge on a schedule, "publish" here means: (a) confirm the local write
  // succeeded (which is what the bridge endpoint serves), and (b) surface a
  // visible failure with retry if it didn't. We also do one silent retry
  // for transient network hiccups before bothering the user.
  const attempt = async (next: boolean, isRetry: boolean): Promise<void> => {
    setSyncState("pending");
    try {
      await update({
        data: {
          id: p.id,
          wardable: next,
          expected_updated_at: p.updated_at,
        } as never,
      });
      setSyncState("idle");
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["sync-status"] });
      toast.success(next ? "Marked ready for ward" : "Ward-ready cleared", {
        description: "Change will appear in the partner app on its next sync.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One silent retry on the first failure — many bridge/network errors
      // are transient. Second failure escalates to a visible retry toast.
      if (!isRetry) {
        await new Promise((r) => setTimeout(r, 800));
        return attempt(next, true);
      }
      setSyncState("failed");
      toast.error("Wardable status did not sync", {
        description: message,
        duration: 12_000,
        action: {
          label: "Retry",
          onClick: () => {
            void attempt(next, false);
          },
        },
      });
    }
  };

  const mut = useMutation({
    mutationFn: (next: boolean) => attempt(next, false),
  });

  const label = isOn ? `Wardable · ${elapsed || "just now"}` : "Wardable";
  const failed = syncState === "failed";
  const pending = mut.isPending || syncState === "pending";

  return (
    <button
      type="button"
      aria-pressed={isOn}
      aria-live="polite"
      title={
        failed
          ? "Sync failed — click to retry"
          : isOn && p.wardable_at
            ? `Marked ready ${fmtDateTime(p.wardable_at)}`
            : "Mark this patient as ready for a ward bed"
      }
      onClick={(e) => {
        // Sits inside the DraggablePatientLink <a>, so stop the click from
        // navigating to the patient page.
        e.preventDefault();
        e.stopPropagation();
        if (pending) return;
        // If the last attempt failed, a click retries the same transition
        // rather than toggling again (the local state hasn't moved).
        mut.mutate(failed ? isOn : !isOn);
      }}
      // Prevent this control from initiating a drag of the parent card.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      disabled={pending}
      className={`inline-flex min-h-[32px] items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors sm:min-h-0 sm:py-0.5 ${
        failed
          ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20"
          : isOn
            ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
            : "border-dashed border-muted-foreground/40 text-muted-foreground hover:border-emerald-500/50 hover:text-emerald-700 dark:hover:text-emerald-300"
      } ${pending ? "opacity-60" : ""}`}

    >
      {failed ? (
        <AlertTriangle className="h-3 w-3" aria-hidden />
      ) : pending ? (
        <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Home className="h-3 w-3" aria-hidden />
      )}
      {failed ? "Sync failed — retry" : pending ? "Syncing…" : label}
    </button>
  );
}

function PatientCardBody({ p, bedLabel }: { p: Patient; bedLabel?: string }) {
  const flags = deriveSafetyFlags(p);
  const obsMap = useContext(AcuityContext);
  const latestObs = obsMap.get(p.id);
  const support = {
    ventilated:
      p.airway_type === "ett" ||
      p.airway_type === "tracheostomy" ||
      (Array.isArray(p.resp_support) && p.resp_support.length > 0),
    rrt: p.renal_rrt === true,
    vasoactive: Array.isArray(p.vasoactive_agents) && p.vasoactive_agents.length > 0,
  };
  const showAcuity = !!latestObs || support.ventilated || support.rrt || support.vasoactive;
  const name = p.full_name ?? "this patient";
  const showMove = p.status === "admitted" || p.status === "referred";
  return (
    <CardContent className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <PatientName patient={p} showAge />
          <p className="truncate text-xs text-muted-foreground">
            {bedLabel ?? formatLocation(p)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showMove && (
            <MoveToBedMenu
              patientId={p.id}
              currentBed={p.bed}
              patientName={name}
            />
          )}
          <Badge className={`${STATUS_BADGE[p.status]} shrink-0`} variant="secondary">
            {STATUS_LABELS[p.status]}
          </Badge>
        </div>
      </div>


      <div className="flex flex-wrap gap-1.5">
        {showAcuity && <AcuityBadge latest={latestObs} support={support} />}
        {flags.hasAllergies && (
          <Badge variant="outline" className="max-w-[12rem] gap-1 border-rose-400 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">Allergy: {flags.allergies}</span>
          </Badge>
        )}
        {flags.dnacpr && (
          <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3 w-3" /> DNACPR
          </Badge>
        )}
        {flags.tep && <Badge variant="outline">TEP</Badge>}
        {flags.isolation && (
          <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
            <BedDouble className="h-3 w-3" /> Isolation
          </Badge>
        )}
        {flags.stale && (
          <Badge variant="outline" className="gap-1 border-muted-foreground/40 text-muted-foreground">
            <Clock className="h-3 w-3" /> {flags.staleHours != null ? `${Math.floor(flags.staleHours)}h` : "Stale"}
          </Badge>
        )}
        {(p.status === "admitted" || p.status === "referred") && <WardableToggle p={p} />}
      </div>
      {p.outstanding_tasks && (
        <p className="line-clamp-2 text-xs text-muted-foreground group-data-[density=compact]/board:hidden">
          <span className="font-medium text-foreground">Tasks: </span>
          {p.outstanding_tasks}
        </p>
      )}
      <div className="group-data-[density=compact]/board:hidden">
        <PatientMetaLine
          patient={p}
          showAge={false}
          trailing={[`Adm ${fmtDate(p.admission_date)}`]}
          className="text-[11px]"
        />
      </div>

    </CardContent>
  );
}

// A compact key-info panel shown when a clinician hovers a patient's bed card.
// Read-only glance: identity, admission reason, organ support, and safety flags
// so staff can triage without opening the full record.
function PatientHoverSummary({ p }: { p: Patient }) {
  const flags = deriveSafetyFlags(p);
  const obsMap = useContext(AcuityContext);
  const latestObs = obsMap.get(p.id);
  const support = {
    ventilated:
      p.airway_type === "ett" ||
      p.airway_type === "tracheostomy" ||
      (Array.isArray(p.resp_support) && p.resp_support.length > 0),
    rrt: p.renal_rrt === true,
    vasoactive: Array.isArray(p.vasoactive_agents) && p.vasoactive_agents.length > 0,
  };
  const showAcuity = !!latestObs || support.ventilated || support.rrt || support.vasoactive;

  const organSupport = [
    support.ventilated && "Ventilated",
    support.vasoactive && "Vasoactive",
    support.rrt && "RRT",
  ].filter(Boolean) as string[];

  const consultant = [p.specialty_consultant, p.parent_specialty].filter(Boolean).join(" · ");

  const keyInvMap = useContext(KeyInvestigationsContext);
  const keyInvestigations = ["Bloods", "CXR", "CT chest"]
    .map((cat) => ({ cat, inv: keyInvMap.get(`${p.id}::${cat}`) }))
    .filter((x) => !!x.inv) as { cat: string; inv: KeyInvestigation }[];

  const Row = ({ label, value }: { label: string; value?: React.ReactNode }) =>
    value ? (
      <div className="flex gap-2 text-xs">
        <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{value}</span>
      </div>
    ) : null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <PatientName patient={p} showAge />
          <p className="truncate text-xs text-muted-foreground">{formatLocation(p)}</p>
        </div>
        <Badge className={`${STATUS_BADGE[p.status]} shrink-0`} variant="secondary">
          {STATUS_LABELS[p.status]}
        </Badge>
      </div>

      {(showAcuity || flags.dnacpr || flags.tep || flags.isolation || flags.hasAllergies) && (
        <div className="flex flex-wrap gap-1.5">
          {showAcuity && <AcuityBadge latest={latestObs} support={support} />}
          {flags.hasAllergies && (
            <Badge variant="outline" className="gap-1 border-rose-400 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-3 w-3 shrink-0" /> Allergy
            </Badge>
          )}
          {flags.dnacpr && (
            <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-3 w-3" /> DNACPR
            </Badge>
          )}
          {flags.tep && <Badge variant="outline">TEP</Badge>}
          {flags.isolation && (
            <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
              <BedDouble className="h-3 w-3" /> Isolation
            </Badge>
          )}
        </div>
      )}

      <div className="space-y-1.5 border-t pt-2">
        <Row label="MRN" value={p.hospital_number || undefined} />
        <Row label="Team" value={consultant || undefined} />
        <Row label="Reason" value={p.current_admission?.trim() || undefined} />
        <Row label="Support" value={organSupport.length ? organSupport.join(", ") : undefined} />
        <Row label="Allergy" value={flags.hasAllergies ? flags.allergies : undefined} />
        <Row
          label="Tasks"
          value={
            p.outstanding_tasks?.trim() ? (
              <span className="line-clamp-3">{p.outstanding_tasks}</span>
            ) : undefined
          }
        />
        <Row label="Admitted" value={fmtDate(p.admission_date)} />
      </div>

      <div className="space-y-1.5 border-t pt-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Latest results
        </p>
        {keyInvestigations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No bloods, CXR or CT chest recorded.</p>
        ) : (
          keyInvestigations.map(({ cat, inv }) => (
            <div key={cat} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-foreground">{cat}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {fmtDateTime(inv.result_at)}
                </span>
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">
                {inv.findings}
              </p>
            </div>
          ))
        )}
      </div>

    </div>
  );
}

// Wraps a bed card so hovering reveals the key-info panel. On touch devices the
// wrapper is inert and the card still opens the record on tap.
function PatientHoverCard({ p, children }: { p: Patient; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  const child = React.isValidElement(children)
    ? React.cloneElement(
        children as React.ReactElement<{
          onLongPress?: () => void;
          suppressClickRef?: React.MutableRefObject<boolean>;
          onDragStart?: (e: React.DragEvent) => void;
        }>,
        {
          onLongPress: () => setOpen(true),
          // Close the summary the moment a drag begins so the floating card
          // can never sit over a drop target.
          onDragStart: (e: React.DragEvent) => {
            setOpen(false);
            (children as React.ReactElement<{ onDragStart?: (e: React.DragEvent) => void }>).props.onDragStart?.(e);
          },
        },
      )
    : children;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>{child}</HoverCardTrigger>
      {/* pointer-events-none ensures the summary panel never intercepts
          drag-over / drop events on beds sitting underneath it. */}
      <HoverCardContent
        align="start"
        className="pointer-events-none w-72 select-none"
      >
        <PatientHoverSummary p={p} />
      </HoverCardContent>
    </HoverCard>
  );
}


// A patient card that can be dragged onto a bed. Click still opens the detail
// page; only a real drag gesture starts a move. Supports mouse (HTML5 drag)
// and touch (long-press pointer drag).
const DraggablePatientLink = React.forwardRef<
  HTMLAnchorElement,
  {
    p: Patient;
    children: React.ReactNode;
    onDragStartPatient?: (p: Patient, e: React.DragEvent) => void;
    onDragEndPatient?: () => void;
    onTouchDragStart?: (p: Patient, e: React.PointerEvent) => void;
    suppressClickRef?: React.MutableRefObject<boolean>;
    onLongPress?: () => void;
  } & React.HTMLAttributes<HTMLAnchorElement>
>(function DraggablePatientLink(
  {
    p,
    children,
    onDragStartPatient,
    onDragEndPatient,
    onTouchDragStart,
    suppressClickRef,
    onLongPress,
    // Handlers injected by HoverCardTrigger (asChild) that must be merged so
    // hover/focus still opens the summary panel while our drag/click logic runs.
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  // Long-press (touch) opens the summary without hover. The trailing click is
  // swallowed so opening the summary doesn't also navigate to the detail page.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    startRef.current = null;
  };

  return (
    <Link
      ref={ref}
      to="/patients/$patientId"
      params={{ patientId: p.id }}
      draggable={!!onDragStartPatient}
      onDragStart={(e) => onDragStartPatient?.(p, e)}
      onDragEnd={() => onDragEndPatient?.()}
      onPointerDown={(e) => {
        if (e.pointerType === "touch" && onLongPress) {
          longPressFiredRef.current = false;
          startRef.current = { x: e.clientX, y: e.clientY };
          clearLongPress();
          longPressTimer.current = setTimeout(() => {
            longPressFiredRef.current = true;
            onLongPress();
          }, 450);
        }
        onTouchDragStart?.(p, e);
      }}
      onPointerMove={(e) => {
        // A real move means the user is scrolling/dragging, not long-pressing.
        if (startRef.current) {
          const dx = Math.abs(e.clientX - startRef.current.x);
          const dy = Math.abs(e.clientY - startRef.current.y);
          if (dx > 8 || dy > 8) clearLongPress();
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={(e) => {
        // Swallow the click that trails a touch-drag or long-press so it doesn't navigate.
        if (longPressFiredRef.current) {
          e.preventDefault();
          longPressFiredRef.current = false;
          return;
        }
        if (suppressClickRef?.current) {
          e.preventDefault();
          suppressClickRef.current = false;
        }
      }}
      style={{ touchAction: "pan-y", ...(rest.style ?? {}) }}
      className={onDragStartPatient ? "block cursor-grab active:cursor-grabbing" : "block cursor-pointer"}
      {...rest}
    >
      {children}
    </Link>
  );
});


function BedBoard({
  roster,
  bedOccupants,
  unassigned,
  onAddToBed,
  dragging,
  draggedPatient,
  touchOverBed,
  onDragStartPatient,
  onDragEndPatient,
  onTouchDragStart,
  suppressClickRef,
  onDropOnBed,
}: {
  roster: Bed[];
  bedOccupants: Map<string, Patient[]>;
  unassigned: Patient[];
  onAddToBed: (bed: string) => void;
  dragging: boolean;
  draggedPatient: Patient | null;
  touchOverBed: string | null;
  onDragStartPatient: (p: Patient, e: React.DragEvent) => void;
  onDragEndPatient: () => void;
  onTouchDragStart: (p: Patient, e: React.PointerEvent) => void;
  suppressClickRef: React.MutableRefObject<boolean>;
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
      {dragging ? (
        <p className="text-xs text-primary">
          Drop the card on a bed to move the patient there.
          {draggedPatient?.isolation_required && " This patient requires isolation — side rooms only."}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Drag a patient card onto a bed to move them. On a tablet or phone, press and hold a card, then drag.
        </p>
      )}
      <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {roster.map((slot) => {
          const bed = slot.label;
          const label = slot.is_side_room ? `Side room ${bed}` : `Bed ${bed}`;
          const occupants = bedOccupants.get(normalizeBed(bed)) ?? [];
          const isOver = overBed === bed || touchOverBed === bed;
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
          // Side rooms get a distinct amber accent so isolation-capable beds are
          // instantly identifiable at a glance across the whole board.
          const sideRoomHeader = slot.is_side_room
            ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
            : "bg-muted/40";
          const HeaderLabel = () => (
            <span className="flex items-center gap-1.5">
              {slot.is_side_room && <DoorClosed className="h-3.5 w-3.5" aria-hidden />}
              <span>{label}</span>
              {slot.is_side_room && (
                <span className="ml-auto rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                  Isolation
                </span>
              )}
            </span>
          );
          if (occupants.length > 0) {
            return (
              <div key={slot.id} data-bed={bed} {...dropHandlers} className={`flex h-full min-h-[240px] flex-col gap-2 rounded-lg transition-shadow ${validRing}`}>
                {occupants.length > 1 && (
                  <p className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" /> {occupants.length} patients in {label}
                  </p>
                )}
                {occupants.map((p) => (
                  <PatientHoverCard key={p.id} p={p}>
                    <DraggablePatientLink
                      p={p}
                      onDragStartPatient={onDragStartPatient}
                      onDragEndPatient={onDragEndPatient}
                      onTouchDragStart={onTouchDragStart}
                      suppressClickRef={suppressClickRef}
                    >
                      <Card className={`h-full transition-colors hover:border-primary/50 ${slot.is_side_room ? "border-amber-500/40" : ""} ${isOver ? overRing : ""}`}>
                        <div className={`flex items-center border-b px-4 py-1.5 text-xs font-semibold ${sideRoomHeader}`}>
                          <HeaderLabel />
                        </div>
                        <PatientCardBody p={p} bedLabel={slot.is_side_room ? "Side room" : undefined} />
                      </Card>
                    </DraggablePatientLink>
                  </PatientHoverCard>
                ))}

              </div>
            );
          }
          const emptySideRoom = slot.is_side_room
            ? "border-amber-500/50 bg-amber-500/5 hover:border-amber-500 hover:bg-amber-500/10"
            : "bg-muted/20 hover:border-primary hover:bg-primary/5";
          return (
            <button
              key={slot.id}
              type="button"
              data-bed={bed}
              onClick={() => onAddToBed(bed)}
              {...dropHandlers}
              className={`group flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-4 text-center transition-colors ${emptySideRoom} ${dragging && ineligible ? "opacity-50" : ""} ${validTarget && !isOver ? "border-primary/60 bg-primary/5 ring-2 ring-primary/30 ring-offset-1 ring-offset-background" : ""} ${isOver ? (ineligible ? "border-destructive bg-destructive/10 ring-2 ring-destructive/40" : "border-primary bg-primary/10 ring-2 ring-primary/40") : ""}`}
            >
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${slot.is_side_room ? "text-amber-900 dark:text-amber-200" : "text-muted-foreground"}`}>
                {slot.is_side_room && <DoorClosed className="h-3.5 w-3.5" aria-hidden />}
                {label}
              </span>
              {slot.is_side_room && (
                <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                  Isolation capable
                </span>
              )}
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
              <PatientHoverCard key={p.id} p={p}>
                <DraggablePatientLink
                  p={p}
                  onDragStartPatient={onDragStartPatient}
                  onDragEndPatient={onDragEndPatient}
                  onTouchDragStart={onTouchDragStart}
                  suppressClickRef={suppressClickRef}
                >
                  <Card className="h-full transition-colors hover:border-primary/50">
                    <PatientCardBody p={p} />
                  </Card>
                </DraggablePatientLink>
              </PatientHoverCard>
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
  onTouchDragStart,
  suppressClickRef,
}: {
  title: string;
  icon: React.ElementType;
  patients: Patient[];
  onDragStartPatient?: (p: Patient, e: React.DragEvent) => void;
  onDragEndPatient?: () => void;
  onTouchDragStart?: (p: Patient, e: React.PointerEvent) => void;
  suppressClickRef?: React.MutableRefObject<boolean>;
}) {
  if (patients.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-4 w-4" /> {title} <span className="text-xs">({patients.length})</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {patients.map((p) => (
          <PatientHoverCard key={p.id} p={p}>
            <DraggablePatientLink
              p={p}
              onDragStartPatient={onDragStartPatient}
              onDragEndPatient={onDragEndPatient}
              onTouchDragStart={onTouchDragStart}
              suppressClickRef={suppressClickRef}
            >
              <Card className="h-full transition-colors hover:border-primary/50">
                <PatientCardBody p={p} />
              </Card>
            </DraggablePatientLink>
          </PatientHoverCard>
        ))}

      </div>
    </div>
  );
}

type RecentMove = {
  key: string;
  at: number;
  label: string;
  previous: { id: string; bed: string | null; location_type: string }[];
};

function RecentMovesStrip({
  moves,
  onRevert,
  onDismiss,
}: {
  moves: RecentMove[];
  onRevert: (m: RecentMove) => void;
  onDismiss: (key: string) => void;
}) {
  if (moves.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">Recent bed moves:</span>
      {moves.map((m) => {
        const seconds = Math.max(1, Math.round((Date.now() - m.at) / 1000));
        const ago = seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
        return (
          <div
            key={m.key}
            className="flex items-center gap-1 rounded-full border bg-background px-2 py-1"
          >
            <span className="truncate max-w-[16rem]">{m.label}</span>
            <span className="text-muted-foreground">· {ago}</span>
            <button
              type="button"
              onClick={() => onRevert(m)}
              className="ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Revert this bed move"
            >
              <Undo2 className="h-3 w-3" /> Revert
            </button>
            <button
              type="button"
              onClick={() => onDismiss(m.key)}
              className="ml-0.5 inline-flex items-center rounded-full p-0.5 text-muted-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Dismiss from recent moves"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
