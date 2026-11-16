// Validates PARTNER_BRIDGE_URL before anything is signed or fetched.
//
// The partner (Critical Care Connect) base must be a bare https origin. Every
// caller appends an absolute "/api/public/bridge/..." path, so a configured
// path would silently double up, and a URL that resolves to THIS app turns the
// inbound sync into a loop that reads (and, in older builds, re-wrote) our own
// records. Both fail closed with a distinct, safe reason.

/** Hostnames that serve this app (published + project-id hosts). */
export const OWN_APP_HOSTS: readonly string[] = ["icu-compass-care.lovable.app"];
const OWN_PROJECT_ID = "58df96bd-2803-4146-90a7-4a08f526bece";

export type PartnerBase =
  | { ok: true; origin: string }
  | { ok: false; reason: "missing" | "invalid" | "self" };

export function isOwnAppHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return OWN_APP_HOSTS.includes(h) || h.includes(OWN_PROJECT_ID);
}

export function parsePartnerBase(raw: string | null | undefined): PartnerBase {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "missing" };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    u.protocol !== "https:" ||
    u.username !== "" ||
    u.password !== "" ||
    (u.pathname !== "/" && u.pathname !== "") ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (isOwnAppHost(u.hostname)) return { ok: false, reason: "self" };
  return { ok: true, origin: u.origin };
}
