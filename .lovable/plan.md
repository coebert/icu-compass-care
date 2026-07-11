# ICU Handover App — Senior Critical Care Review & Improvement Plan

Reviewed as a Salisbury Critical Care consultant/senior-nurse group. The app is already strong: bed board with drag/drop, systems-based patient cards, escalation/resus, NOK, investigations, microbiology, specialty reviews, timeline, tasks, handover PDF, bridge sync with the referral app, audit and RBAC. The gaps below are about turning a good record into a genuine day-to-day clinical workhorse.

## What works well (keep)
- Systems-by-systems structure mirrors how we hand over.
- Bed board with eligibility/isolation logic and undo is excellent ergonomics.
- Retain-not-delete lifecycle, audit trail, and strict RLS suit clinical governance.
- Deterministic handover PDF with recency selection.

## Key findings (clinician perspective)

### 1. Clinical content gaps
- **No structured observations / trend.** Everything physiological is free text. We can't see a NEWS2 or a simple obs trend (HR/BP/SpO2/temp, ventilator settings, lactate) at a glance. This is the single biggest utility gap.
- **No severity/organ-support scoring.** No SOFA (or even organ-support count) to convey acuity at handover or for the board.
- **No fluid balance / 24h summary.** Ubiquitous on a ward round; currently absent.
- **Allergies not first-class.** Allergy lives inside free text; it should be a prominent, structured, always-visible safety field (like DNACPR).
- **Weight / dosing basis not surfaced** despite being carried from referral.
- **Lines & devices not tracked** (CVC/arterial/VAS/CVL/drains with insertion dates) — needed for daily line reviews and infection surveillance.
- **VTE / stress-ulcer / glycaemic "daily goals" checklist** (FAST-HUG style) missing — high-yield safety net.

### 2. Ergonomics / workflow
- **Patient page is a 2,264-line monolith with 9 tabs.** Slow to scan on a ward round; overview should be a single dense, printable "one-look" summary.
- **Tasks are unstructured.** No owner, no due time, no priority, no "for ward round vs jobs list" split; can't see all outstanding jobs unit-wide.
- **No unit-level dashboard.** No single view of occupancy, acuity, isolation, outstanding jobs, DNACPR/TEP status, or overdue reviews across the whole unit.
- **No explicit shift-handover workflow.** Handover is a PDF export, not a "handover mode" (read-out order, acknowledgement, what-changed-since-last-shift).
- **Board cards are light on safety flags.** Isolation shows, but DNACPR/TEP ceiling, allergy, and acuity aren't glanceable on the card.
- **"What changed" not surfaced.** patient_field_changes exists but there's no per-patient "recent changes" ribbon for the incoming team.

### 3. Safety & data quality
- `full_name` capped at 10 chars (initials-only) is deliberate for IG, but the board/PDF should make the identity model explicit to avoid mis-ID.
- Allergy and weight being free-text is a prescribing-safety risk.
- No "stale record" indicator (last meaningful clinical update age) on the board.

---

## Implementation plan (phased)

### Phase 1 — High-yield safety & glanceability (low risk, mostly frontend)
1. **Structured allergies** field (array of {substance, reaction, severity}) surfaced prominently on the card header, board card, and handover PDF. Migration + schema + form + display.
2. **Board safety flags:** add DNACPR/TEP-ceiling chip, allergy chip, isolation (existing), and a "stale > Xh" indicator to each bed/patient card.
3. **Overview "one-look" summary:** restructure the Overview tab into a single dense, print-friendly panel (identity + acuity + safety flags + systems one-liners + active jobs) so a ward round needs no tab switching.
4. **Daily goals / FAST-HUG checklist** (VTE, stress ulcer, glucose, sedation hold, head-up, catheter review, bowels, nutrition) as structured toggles with a "last reviewed" stamp.

### Phase 2 — Tasks & unit dashboard (ergonomics)
5. **Upgrade tasks:** add owner, priority, due time, and category (ward-round item vs job). Reuse existing patient_tasks (add columns).
6. **Unit dashboard route** (`/unit`): occupancy grid, acuity/organ-support counts, isolation list, outstanding jobs across all patients, patients with no DNACPR/TEP decision, overdue specialty reviews.
7. **"What changed since" ribbon** on the patient page and dashboard, driven by existing `patient_field_changes`.

### Phase 3 — Structured physiology (largest, highest utility) — DONE
8. **Observations model:** ✅ `patient_observations` table (timestamped HR, BP, MAP, SpO2, FiO2, RR, temp, GCS, lactate, vent mode/PEEP/Vt, vasopressor + dose, urine, fluid in/out) + GRANT + RLS + server fns (`observations.functions.ts`).
9. **Compact trend view:** ✅ sparkline mini-charts + numeric "latest obs" block in the new Observations tab (`observations-card.tsx`). (PDF integration deferred.)
10. **Organ-support / SOFA-lite score:** ✅ `computeAcuity` in `observations.ts`, shown as an acuity badge on the board cards and unit dashboard.
11. **Fluid balance:** ✅ 24h in/out/net capture and display in the Observations tab.


### Phase 4 — Handover workflow & devices
12. **Lines & devices tracker** (type, site, insertion date, days in-situ, remove-by prompt) with an infection-surveillance view.
13. **Shift-handover mode:** ordered read-out (by bed), per-patient "handover given/received" acknowledgement, and an auto "changes since last handover" section; extend the existing PDF.
14. **Refactor patients.$patientId.tsx** into per-tab components alongside the above (reduce the monolith; no behaviour change).

---

## Technical notes
- All new tables: `CREATE TABLE` in `public` + explicit `GRANT` to `authenticated`/`service_role` + `ENABLE RLS` + shared-team policies matching existing patient tables; add to bridge schema only where the partner app needs it.
- New reads/writes as `createServerFn` with `requireSupabaseAuth`, mirroring `patient-tasks.functions.ts`.
- Keep free-text systems fields (clinicians rely on narrative) — add structure alongside, never replace.
- Preserve handover PDF determinism; extend `handover-columns.ts`/`handover-types.ts` rather than rewriting.
- Each phase ships independently with typecheck + existing test suite green.

## Suggested first step
Phase 1 (structured allergies + board safety flags + one-look Overview + daily-goals checklist) delivers the most clinical safety value per unit of work and is almost entirely additive. I'd recommend starting there.
