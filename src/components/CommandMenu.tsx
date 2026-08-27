import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { listPatients } from "@/lib/patients.functions";
import { listBeds } from "@/lib/beds.functions";
import {
  BedDouble,
  History,
  LayoutDashboard,
  Shield,
  Building2,
  ShieldCheck,
  User as UserIcon,
  Users,
  UserSearch,
} from "lucide-react";

/**
 * Global command palette (⌘K / Ctrl+K).
 *
 * Populated from React Query cache when possible — the palette registers its
 * own queries but they share cache keys with the patients board and bed
 * roster, so opening it is essentially free after the first load.
 */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const listPatientsFn = useServerFn(listPatients);
  const listBedsFn = useServerFn(listBeds);

  // Fetch lazily — only when the palette has been opened at least once.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (open) setEnabled(true);
  }, [open]);

  const { data: patients } = useQuery({
    queryKey: ["patients"],
    queryFn: () => listPatientsFn(),
    enabled,
    staleTime: 30_000,
  });
  const { data: beds } = useQuery({
    queryKey: ["beds"],
    queryFn: () => listBedsFn(),
    enabled,
    staleTime: 60_000,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmdK =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (cmdK) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const go = useCallback(
    (fn: () => void) => {
      setOpen(false);
      // Defer navigation so the dialog can close cleanly and return focus.
      setTimeout(fn, 0);
    },
    [],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search patient by name / MRN, bed, or action…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {patients && patients.length > 0 && (
          <CommandGroup heading="Patients">
            {patients.slice(0, 40).map((p: any) => {
              const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed";
              const mrn = p.mrn ? `MRN ${p.mrn}` : "";
              const bed = p.bed ? `Bed ${p.bed}` : "";
              const meta = [mrn, bed].filter(Boolean).join(" · ");
              // cmdk matches on `value`, so pack searchable text into it.
              const value = `${name} ${p.mrn ?? ""} ${p.bed ?? ""} ${p.nhs_number ?? ""}`;
              return (
                <CommandItem
                  key={p.id}
                  value={value}
                  onSelect={() =>
                    go(() =>
                      navigate({ to: "/patients/$patientId", params: { patientId: p.id } }),
                    )
                  }
                >
                  <UserSearch />
                  <span className="flex-1 truncate">{name}</span>
                  {meta && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">{meta}</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {beds && beds.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Beds">
              {beds.map((b: any) => (
                <CommandItem
                  key={b.id}
                  value={`bed ${b.label}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/patients",
                        search: { q: b.label, sex: "all", archived: false, density: "detailed", preset: "" },
                      }),
                    )
                  }
                >
                  <BedDouble />
                  <span className="flex-1">Bed {b.label}</span>
                  {b.is_side_room && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">Side room</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Navigate">
          <CommandItem value="patients board" onSelect={() => go(() => navigate({ to: "/patients" }))}>
            <Users />
            <span>Patients board</span>
          </CommandItem>
          <CommandItem value="handover history" onSelect={() => go(() => navigate({ to: "/patients/history" }))}>
            <History />
            <span>Handover history</span>
          </CommandItem>
          <CommandItem value="unit dashboard" onSelect={() => go(() => navigate({ to: "/unit" }))}>
            <LayoutDashboard />
            <span>Unit dashboard</span>
          </CommandItem>
          <CommandItem value="bed roster admin" onSelect={() => go(() => navigate({ to: "/beds" }))}>
            <BedDouble />
            <span>Bed roster</span>
          </CommandItem>
          <CommandItem value="staff admin" onSelect={() => go(() => navigate({ to: "/admin" }))}>
            <Shield />
            <span>Staff & admin</span>
          </CommandItem>
          <CommandItem value="hospital unit access roles" onSelect={() => go(() => navigate({ to: "/access" }))}>
            <Building2 />
            <span>Hospital &amp; unit access</span>
          </CommandItem>
          <CommandItem value="security faq" onSelect={() => go(() => navigate({ to: "/security-faq" }))}>
            <ShieldCheck />
            <span>Security FAQ</span>
          </CommandItem>
          <CommandItem value="my profile settings" onSelect={() => go(() => navigate({ to: "/settings" }))}>
            <UserIcon />
            <span>My profile</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Tip">
          <CommandItem disabled value="__tip">
            <span className="text-muted-foreground">Open anywhere with</span>
            <CommandShortcut>⌘K / Ctrl+K</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
