// Lazy accessor for the service-role Supabase admin client.
//
// The admin client (service-role key, RLS bypassed) must never enter a client
// bundle, so it is dynamically imported on first use rather than imported at
// module scope. This helper centralises that one-liner so privileged handlers
// read `const admin = await getAdmin()` instead of repeating the dynamic import.
export async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}
