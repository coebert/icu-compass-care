// Shared antimicrobial helpers used by both the patient detail UI and the
// handover PDF export, so the course-day calculation cannot drift between them.

export type Antimicrobial = {
  name?: string;
  started_on?: string;
  ended_on?: string | null;
};

/**
 * Normalize an antimicrobial name so trivial spacing/casing differences can't
 * create duplicates. Trims the ends and collapses any run of internal
 * whitespace to a single space. Casing is preserved for display; callers that
 * compare for duplicates should lowercase the result.
 */
export function normalizeAntimicrobialName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Whole-day inclusive course length between a start and (end|today), or null. */
export function courseDays(startedOn?: string | null, endedOn?: string | null): number | null {
  if (!startedOn) return null;
  const start = new Date(startedOn + "T00:00:00");
  if (isNaN(start.getTime())) return null;
  let end: Date;
  if (endedOn) {
    end = new Date(endedOn + "T00:00:00");
    if (isNaN(end.getTime())) return null;
  } else {
    end = new Date();
    end.setHours(0, 0, 0, 0);
  }
  const diff = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return diff < 0 ? null : diff + 1;
}
