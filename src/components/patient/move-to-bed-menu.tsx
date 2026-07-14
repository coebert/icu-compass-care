import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { BedDouble, Home, MoveRight } from "lucide-react";
import { listBeds, type Bed } from "@/lib/beds.functions";
import { updatePatient } from "@/lib/patients.functions";
import { normalizeBed } from "@/lib/icu-beds";
import { toast } from "sonner";

type MoveTarget =
  | { kind: "bed"; label: string }
  | { kind: "unassign" };

/**
 * Keyboard-accessible "Move to bed…" action for a patient card.
 *
 * Drag-and-drop is fast on desktop but unusable on keyboard-only workflows
 * and awkward on touch, so every patient card also exposes this picker.
 * Shows the ICU bed roster (with a chip on beds that already have an
 * occupant), plus an "Unassigned" option that clears the bed but keeps the
 * patient in ICU.
 */
export function MoveToBedMenu({
  patientId,
  currentBed,
  patientName,
  occupantsByBed,
  onMoved,
}: {
  patientId: string;
  currentBed: string | null | undefined;
  patientName: string;
  /** Map of normalized bed label → occupant count, so we can flag conflicts. */
  occupantsByBed?: Map<string, number>;
  onMoved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const listBedsFn = useServerFn(listBeds);
  const updatePatientFn = useServerFn(updatePatient);

  const { data: beds = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => listBedsFn(),
    enabled: open,
    staleTime: 60_000,
  });

  const mut = useMutation({
    mutationFn: (target: MoveTarget) =>
      updatePatientFn({
        data: {
          id: patientId,
          bed: target.kind === "bed" ? target.label : null,
          location_type: "icu",
        } as never,
      }),
    onSuccess: (_res, target) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      notify_success(
        target.kind === "bed"
          ? `Moved ${patientName} to Bed ${target.label}`
          : `${patientName} is now unassigned`,
      );
      onMoved?.();
    },
    onError: (e: Error) =>
      toast.error("Could not move patient", { description: e.message, duration: 10000 }),
  });

  function notify_success(msg: string) {
    toast.success(msg);
  }


  const currentKey = currentBed ? normalizeBed(currentBed) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Move ${patientName} to a different bed`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoveRight className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0" onClick={(e) => e.stopPropagation()}>
        <Command>
          <CommandInput placeholder="Move to bed…" />
          <CommandList>
            <CommandEmpty>No beds match.</CommandEmpty>
            <CommandGroup heading="ICU beds">
              {beds.map((b: Bed) => {
                const key = normalizeBed(b.label);
                const occ = occupantsByBed?.get(key) ?? 0;
                const isCurrent = key === currentKey;
                return (
                  <CommandItem
                    key={b.id}
                    value={`bed ${b.label}${b.is_side_room ? " side room" : ""}`}
                    disabled={mut.isPending || isCurrent}
                    onSelect={() => {
                      if (isCurrent) return;
                      setOpen(false);
                      mut.mutate({ kind: "bed", label: b.label });
                    }}
                  >
                    <BedDouble />
                    <span className="flex-1">Bed {b.label}</span>
                    {b.is_side_room && (
                      <span className="ml-1 shrink-0 rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                        SR
                      </span>
                    )}
                    {isCurrent ? (
                      <span className="ml-1 shrink-0 text-xs text-muted-foreground">Current</span>
                    ) : occ > 0 ? (
                      <span className="ml-1 shrink-0 text-xs text-amber-600 dark:text-amber-400">
                        Occupied
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Other">
              <CommandItem
                value="unassign no bed"
                disabled={mut.isPending || !currentBed}
                onSelect={() => {
                  setOpen(false);
                  mut.mutate({ kind: "unassign" });
                }}
              >
                <Home />
                <span>Unassign (keep in ICU)</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
