
# ICU Handover — UX & Ergonomics Improvement Plan

Based on a full-app design audit. Findings are cited with file paths in the audit; this plan groups the fixes into 5 rollout phases so the highest safety/usability wins ship first without churning the whole app in one go.

Each phase is independently shippable. After each phase we can pause, review with users, then continue.

---

## Phase 1 — Safety & consistency of destructive actions (highest priority)

Rationale: the biggest cross-cutting risk we found was that clinically significant deletes are one-tap, no-confirm, and inconsistent between near-identical surfaces.

1. Add a shared `ConfirmDestructive` wrapper (thin AlertDialog helper) and apply it uniformly to every delete/destroy button:
   - Observation delete, Line delete, Microbiology delete, Timeline event delete, Bed remove, Investigation delete (verify), Patient delete cascade wording.
2. Rewrite the Patient delete warning text to name every cascade (obs, lines, micro, reviews, timeline, audit).
3. Add confirmation to role changes in Admin (Make admin / Make clinician), plus a short "why this matters" line.
4. Add a warning + block on Bed remove when the bed currently has an occupant.
5. Move Delete out of the header action row on the patient page into a "Danger zone" section at the bottom of the Status tab, visually separated from Edit/Handover PDF.
6. Extend the existing 10s undo toast on bed moves to include a persistent "recent moves" strip (last 3 moves, click to revert) so an unseen toast isn't the only rescue path.

## Phase 2 — Ward-round ergonomics (bed board + patient tabs)

Rationale: this is where most clinician time is spent; small friction here compounds every round.

1. Persist bed-board state in the URL: search, sex filter, sort, view density. Use TanStack search-param validation. Same for Handover History filters and Timeline filters.
2. Persist the active patient-detail tab in the URL (`?tab=escalation`) so deep links, refresh, and browser back/forward preserve context. Keep the existing Timeline → Investigations `focus` mechanism.
3. Add a visible chevron/gradient overflow affordance on the 11-tab TabsList so scrolled-off tabs are discoverable on narrow viewports; consider grouping less-used tabs (Status, History) into a "More" menu on <md widths.
4. Raise all primary-touch controls to 44×44:
   - Wardable pill on bed cards.
   - Icon-only nav buttons (Patients / History / Unit / Security / Profile).
   - Delete/edit icon buttons inside card lists.
5. Replace hover-only affordances with tap-friendly equivalents:
   - `EditableField` pencil: show a subtle always-visible edit icon on touch (media query or `@media (pointer: coarse)`), not just on `group-hover`.
   - `PatientHoverCard` on touch: add a visible "info" affordance (small chip) alongside the long-press so the feature is discoverable.
6. Add a compact/detailed toggle on the bed board for large units (persisted in URL).

## Phase 3 — Data-entry consistency & validation

Rationale: two different edit paths for the same field (inline vs full modal) causes confusion and increases conflict risk.

1. Retire the full `PatientForm` modal on the patient detail page for fields already inline-editable. Keep the modal only for initial patient creation (new-patient flow) and for the escalation/NOK block that is currently read-only. Add inline editing to Escalation & Resus and NOK tabs using the existing `EditableField` primitive.
2. Add range validators to Observations numeric fields (HR, BP, MAP, SpO₂, RR, temperature, lactate, PEEP, Vt) with soft warnings ("Value outside physiological range — confirm?") rather than hard blocks.
3. Batch `CheckboxOptionGroup` toggles: local optimistic state + a single debounced save (300ms) instead of a serial round-trip per click. Show a subtle "Saving…/Saved" pill in the widget header.
4. Change Timeline Quick-add so no DB row is created until the user confirms in the inline editor (or auto-purge empty "Other" events created and abandoned within 5 minutes).
5. Fix TEP colour semantics: pick a shared clinical colour system (e.g. destructive = safety-critical restriction, warning = attention needed, secondary = neutral state) and apply to DNACPR, TEP, isolation, wardable, deteriorating consistently. Add a one-line legend accessible from a "?" icon on the badges row.
6. Unify toast conventions: success = 4s, warning/conflict = 10s with action, destructive-outcome = persistent until dismissed. Extract into a `notify` helper.

## Phase 4 — Awareness, staleness & real-time

Rationale: this is a shared clinical record with no presence signalling today.

1. Add a Supabase Realtime channel scoped per patient: broadcast "user X viewing/editing" presence. Show small avatars in the patient header. On field edit, show a soft yellow ring on any field another user is currently editing.
2. Add per-section "Updated HH:mm by Name" line under each Overview widget, Observations, Investigations, Micro, Reviews. Uses existing audit/field-change data.
3. Replace the post-hoc "CONFLICT:" toast with a diff dialog: "This field changed while you were editing. Yours: … / Theirs: … / Keep mine / Keep theirs / Merge."
4. On the Unit dashboard, add a soft `refetchInterval` (30s) and a "Last synced" timestamp; make stat cards clickable to filter the bed board.
5. Add an offline banner (`navigator.onLine` + Supabase channel status) with a queued-writes indicator. Block risky writes when offline; allow read-only browsing.

## Phase 4.5 — Follow-ups (shipped)

1. Per-section "Updated HH:mm" line under Observations, Lines, Investigations, Microbiology, Reviews via a shared `<SectionUpdated />` helper that reads `updated_at`/`created_at` from the section's own list — no extra fetch. Author attribution is deferred until the audit trail covers all detail tables (currently only `patients`/`investigations` write to `record_audit`).
2. Clickable stat cards on the Unit dashboard link into the bed board with a new `preset` search param (`vent`, `vasoactive`, `rrt`, `noresus`). The board renders a clearable "Filter: <label>" chip below the heading and applies the preset to the list.

Still deferred:
- Conflict diff dialog for concurrent edits (requires an optimistic-concurrency layer on every editable surface).
- Queued-writes indicator (no offline mutation queue exists yet).

## Phase 5 — Accessibility, discoverability & polish

1. Audit every icon-only button for `aria-label`. Standardise on the shadcn Button `aria-label` pattern; add lint rule if possible.
2. Replace all `<p>Loading…</p>` placeholders with skeleton loaders shaped like the target content; distinguish "loading" from "empty" states clearly.
3. Add keyboard-accessible "Move to bed…" command on each patient card (opens a picker) so drag-and-drop isn't the only way to relocate a patient.
4. Add a global command palette (⌘K) for: jump to patient by name/MRN, jump to bed, common actions (mark wardable, add event, add obs). Populates from React Query cache.
5. Add a shared clinical-colour legend page under Security/FAQ, and link from the "?" chip introduced in Phase 3.
6. Add "forgot password" link and inline (non-toast) error region on the Auth page with `aria-live="polite"`.
7. Fill the audit gaps: review `patients.compare.tsx`, `patients.handover-mode.tsx`, `patients.handover-preview.tsx`, `patients.sharing.tsx`, `settings.tsx`, `reconcile.tsx`, `setup.tsx`, `antimicrobials.tsx` — they're likely to surface more of the same patterns and Handover Mode is the actual bedside surface during rounds.

---

## Suggested sequencing

- **Phase 1**: 1 short cycle. Almost all shadcn AlertDialog work + one shared helper. Low risk, high safety payoff.
- **Phase 2**: URL state + touch targets. Medium effort, spread across bed board and patient page.
- **Phase 3**: Inline-editing convergence is the biggest single refactor; do it after Phase 1 & 2 so the destructive/URL infra is already stable.
- **Phase 4**: Introduces Realtime — new infra; ship after the editing model is settled so presence has one clear model to attach to.
- **Phase 5**: Ongoing polish and closing the audit gaps.

## Notes / open questions to confirm before Phase 1 starts

- Whether Investigations delete already uses AlertDialog (file was truncated in the audit — quick verify).
- Whether any Realtime channel already exists elsewhere in `src/lib` we should extend rather than add.
- Which surfaces are the actual bedside-round view (Handover Mode vs. patient detail) — will shape Phase 2 tap-target priorities.

If you approve, I'll start with **Phase 1** in the next turn.
