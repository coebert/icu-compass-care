// Client-safe safety constants and helpers shared by the patient board,
// the patient detail page, the edit form and the handover PDF. Keeping these
// in one place stops the allergy / daily-goals model from drifting between
// the places that read and write it.

export const ALLERGY_SEVERITIES = [
  "unknown",
  "mild",
  "moderate",
  "severe",
  "anaphylaxis",
] as const;

export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

export const ALLERGY_SEVERITY_LABEL: Record<AllergySeverity, string> = {
  unknown: "Unknown",
  mild: "Mild",
  moderate: "Moderate",
  severe: "Severe",
  anaphylaxis: "Anaphylaxis",
};

export type AllergyEntry = {
  substance: string;
  reaction?: string | null;
  severity?: AllergySeverity | null;
};

// Daily-goals (FAST-HUG style) checklist. Order here is the display order.
export const DAILY_GOAL_ITEMS = [
  { key: "feeding", label: "Feeding / nutrition", hint: "Enteral or parenteral nutrition addressed" },
  { key: "analgesia", label: "Analgesia", hint: "Adequate pain control reviewed" },
  { key: "sedation", label: "Sedation hold", hint: "Daily sedation hold / target RASS" },
  { key: "vte", label: "VTE prophylaxis", hint: "Pharmacological or mechanical thromboprophylaxis" },
  { key: "stress_ulcer", label: "Stress ulcer prophylaxis", hint: "GI protection where indicated" },
  { key: "glucose", label: "Glucose control", hint: "Glycaemic target reviewed" },
  { key: "head_up", label: "Head-up 30°", hint: "Bed elevated to reduce VAP risk" },
  { key: "catheter_review", label: "Line / catheter review", hint: "Lines & catheters reviewed for removal" },
  { key: "bowels", label: "Bowels", hint: "Bowels opened / laxative plan" },
] as const;

export type DailyGoalKey = (typeof DAILY_GOAL_ITEMS)[number]["key"];
export type DailyGoals = Partial<Record<DailyGoalKey, boolean>>;

export function parseAllergies(value: unknown): AllergyEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({
      substance: String(v.substance ?? "").trim(),
      reaction: v.reaction != null ? String(v.reaction) : null,
      severity: (ALLERGY_SEVERITIES as readonly string[]).includes(String(v.severity))
        ? (v.severity as AllergySeverity)
        : null,
    }))
    .filter((a) => a.substance.length > 0);
}

export function parseDailyGoals(value: unknown): DailyGoals {
  if (!value || typeof value !== "object") return {};
  const out: DailyGoals = {};
  for (const item of DAILY_GOAL_ITEMS) {
    const v = (value as Record<string, unknown>)[item.key];
    if (typeof v === "boolean") out[item.key] = v;
  }
  return out;
}

export function dailyGoalsProgress(goals: DailyGoals): { done: number; total: number } {
  const total = DAILY_GOAL_ITEMS.length;
  const done = DAILY_GOAL_ITEMS.filter((i) => goals[i.key]).length;
  return { done, total };
}

// One-line allergy summary for compact places (board card, PDF).
export function summariseAllergies(value: unknown): string {
  const list = parseAllergies(value);
  if (list.length === 0) return "";
  return list.map((a) => a.substance).join(", ");
}

export const STALE_THRESHOLD_HOURS = 12;

// Hours since a record was last updated, or null when unknown.
export function hoursSince(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 36e5;
}

export function isStale(iso: unknown, thresholdHours = STALE_THRESHOLD_HOURS): boolean {
  const h = hoursSince(iso);
  return h !== null && h >= thresholdHours;
}

export type SafetyFlags = {
  dnacpr: boolean;
  tep: boolean;
  isolation: boolean;
  allergies: string; // summary text, empty when none recorded
  hasAllergies: boolean;
  stale: boolean;
  staleHours: number | null;
};

// Derive the glanceable safety flags for a patient row.
export function deriveSafetyFlags(p: Record<string, unknown>): SafetyFlags {
  const summary = summariseAllergies(p.allergies);
  return {
    dnacpr: p.dnacpr_decision === true,
    tep: p.tep_in_place === true,
    isolation: p.isolation_required === true,
    allergies: summary,
    hasAllergies: summary.length > 0,
    stale: isStale(p.updated_at),
    staleHours: hoursSince(p.updated_at),
  };
}
