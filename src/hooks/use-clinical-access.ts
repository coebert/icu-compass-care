import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMe } from "@/lib/me.functions";

// Clinical access = admin or clinician role. These are the staff permitted to
// view patient field-change history and handover snapshot history in the UI.
// This is a UX gate only; the authoritative check is enforced by RLS/server
// functions. It reuses the shared ["me"] query so it is effectively free.
export function useClinicalAccess() {
  const me = useServerFn(getMe);
  const { data: profile, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => me(),
  });
  const roles = profile?.roles ?? [];
  const hasClinicalAccess = roles.includes("admin") || roles.includes("clinician");
  return { hasClinicalAccess, isLoading, profile };
}
