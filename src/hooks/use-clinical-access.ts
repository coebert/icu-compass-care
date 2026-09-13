import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMe } from "@/lib/me.functions";

// Clinical access = a clinical recording role (clinician or unit administrator). These are the staff permitted to
// view patient field-change history and handover snapshot history in the UI.
// This is a UX gate only; the authoritative check is enforced by RLS/server
// functions. It reuses the shared ["me"] query so it is effectively free.
export function useClinicalAccess() {
  const me = useServerFn(getMe);
  const { data: profile, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => me(),
  });
  // Trust administrators hold clinical rights in every unit, so canEditClinical
  // already covers them; the isTrustAdmin term is kept as a belt-and-braces
  // fallback for older cached ["me"] payloads.
  const hasClinicalAccess = Boolean(profile?.canEditClinical) || Boolean(profile?.isTrustAdmin);
  return { hasClinicalAccess, isLoading, profile };
}
