import type { HandoverPdfOptions } from "@/lib/handover-pdf";

/**
 * Header/footer presets let staff save and reuse their preferred ICU handover
 * title, subtitle, footer text, filename format and toggles across sessions.
 * Presets are stored in localStorage (a per-user, per-device preference), so
 * they persist without touching clinical data or the backend.
 */

export type HandoverPreset = {
  id: string;
  name: string;
  options: HandoverPdfOptions;
};

const STORAGE_KEY = "icu-handover-presets";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** Read all saved presets. Returns an empty list on the server or when none exist. */
export function loadHandoverPresets(): HandoverPreset[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is HandoverPreset =>
        p && typeof p.id === "string" && typeof p.name === "string" && p.options,
    );
  } catch {
    return [];
  }
}

function persist(presets: HandoverPreset[]): HandoverPreset[] {
  if (isBrowser()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch {
      /* ignore quota / serialization errors */
    }
  }
  return presets;
}

function makeId(): string {
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Save a preset. If a preset with the same (case-insensitive) name exists it is
 * overwritten so re-saving under a known name updates it. Returns the full list.
 */
export function saveHandoverPreset(name: string, options: HandoverPdfOptions): HandoverPreset[] {
  const trimmed = name.trim();
  if (!trimmed) return loadHandoverPresets();
  const existing = loadHandoverPresets();
  const match = existing.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const next: HandoverPreset = {
    id: match?.id ?? makeId(),
    name: trimmed,
    options,
  };
  const list = match
    ? existing.map((p) => (p.id === match.id ? next : p))
    : [...existing, next];
  return persist(list);
}

/** Delete a preset by id. Returns the remaining list. */
export function deleteHandoverPreset(id: string): HandoverPreset[] {
  return persist(loadHandoverPresets().filter((p) => p.id !== id));
}
