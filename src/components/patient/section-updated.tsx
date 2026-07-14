import { fmtDateTime } from "@/lib/icu";

// Shown at the top of each patient section (Observations, Lines, Investigations,
// Microbiology, Reviews) to make record staleness visible during rounds.
// Falls back gracefully when no items exist.
export function SectionUpdated({
  items,
  by,
  className,
}: {
  items: ReadonlyArray<{ updated_at?: string | null; created_at?: string | null } | Record<string, any>>;
  by?: string | null;
  className?: string;
}) {
  if (!items || items.length === 0) return null;
  let latest = 0;
  for (const it of items) {
    const t = it?.updated_at ?? it?.created_at ?? null;
    if (!t) continue;
    const n = new Date(t).getTime();
    if (!Number.isNaN(n) && n > latest) latest = n;
  }
  if (!latest) return null;
  return (
    <p className={`text-xs text-muted-foreground ${className ?? ""}`}>
      Updated {fmtDateTime(new Date(latest).toISOString())}
      {by ? ` · ${by}` : ""}
    </p>
  );
}
