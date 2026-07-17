
## Radnor Chart Digitisation — implementation plan

Turn a mobile photo of the paper Radnor 24-hour chart into structured data that (a) drives a digital replica chart per patient/day and (b) auto-fills the existing observations, fluid balance, investigations, microbiology and systems-review sections used in the handover.

### Governance guardrails (non-negotiable)

- Chart images are **transient**. They are uploaded from the browser as base64 straight into a server function, passed to the vision model, and discarded when the response returns. No storage bucket, no `patients/*` table column, no logging of the raw bytes, no CDN copy.
- The server function scrubs any patient-identifying free text before returning (name, DOB, address, NHS number if scanned from the sticker) — only **hospital number** and **initials** are kept, matching existing app precedent (`icu.ts` display rules).
- Server-side rate-limit + audit log entry per scan (who/when/patient linked, no payload). Uses existing `record_audit` + `audit_log` tables.
- Vision call goes through Lovable AI Gateway (no user API keys). Model: `google/gemini-3-pro-image` capable multimodal (`google/gemini-2.5-pro`) — chosen for handwriting + table OCR.
- Confirmation UI: nothing writes to the patient record until the clinician reviews the extracted fields on a diff screen and hits Confirm.

### Data model

New tables (single migration, with GRANTs + RLS mirroring the other clinical tables — authenticated read/write, service_role all):

- `chart_days` — one row per patient per 24h chart period.
  - `id`, `patient_id`, `chart_date` (date), `created_by`, `created_at`, `updated_at`, `source` enum('scan','manual'), `notes`.
  - Unique (`patient_id`, `chart_date`).
- `chart_hourly` — hourly grid rows (24 per chart).
  - `chart_day_id`, `hour` (0–23), fluid intake/output columns matching the paper chart (`intake_ml`, `flushes_ml`, `ng_aspirate_ml`, `ng_free_ml`, `urine_ml`, `bowels`, `target_removal_ml`, `actual_removal_ml`, `hourly_balance_ml`, `cumulative_balance_ml`), vitals block (`hr`, `sbp`, `dbp`, `map`, `cvp`, `spo2`, `etco2`, `rr`, `temp`, `gcs`, `cam_icu`, `pupils_l`, `pupils_r`), vent block (`mode`, `peep`, `fio2`, `p_support`, `tv`, `mv`, `peak_pressure`), ABG optional block.
  - PK (`chart_day_id`, `hour`).
- `chart_infusions` — free-form infusion rows with 24-hour rate array (`name`, `dose_unit`, `rates jsonb[24]`).
- `chart_care_bundle` — ventilator care bundle Y/N/exclusion per shift.
- `chart_assessments` — daily assessment text per system (resp / cvs / renal / cns / gi / skin) with targets (target_map, target_urine, target_sats, etc.).

The digital chart page reads/writes these directly. When rows are inserted from a confirmed scan, we also **write-through** the mapped fields into the existing tables so the rest of the app benefits automatically:

- Latest hourly vitals row → `patient_observations` insert (one composite obs per hour that has data).
- Investigation ticks (CXR / ECG / cultures / MRSA / MC+S / Sputum / Swabs) → `investigations` inserts.
- Microbiology specimens → `microbiology_results` inserts.
- Daily assessment text → `patients.systems_resp/cvs/renal/neuro/gastro/haem/micro/other` update, plus targets (`target_map`, etc. — added if not present).
- 24h balance → summary field or stored on `chart_days` and rendered on handover.

### Server layer

- `src/lib/chart-extract.functions.ts` (protected server fn, `requireSupabaseAuth`):
  - Input: `{ patientId, chartDate, pages: string[] /* base64 image data URLs */ }` — max 3 pages, per-image size validated, MIME allow-list.
  - Handler builds a Gemini `google/gemini-2.5-pro` chat-completion via the AI Gateway with a strict system prompt: "You are extracting a Radnor 24h ICU chart. Return JSON matching this schema. Never invent values. Use null for illegible cells."
  - Uses AI SDK `generateText` + `Output.object` with a *modest* Zod schema (chart-level metadata, `hourly[]` up to 24, `infusions[]`, `investigations[]`, `microbiology[]`, `assessments{}`, `care_bundle{}`). Follows the schema-simplicity rules from `ai-sdk-agent-patterns` (no bounds, no long enums; clamp in code).
  - Post-processing: strip name/DOB from any field, coerce hospital-number cross-check with the requested patient, derive initials, compute cumulative balance, validate hours 0–23.
  - Returns the parsed payload and a per-field confidence score. **Never returns the image.**
  - Emits an `audit_log` row (`scan_attempt`, `scan_success`/`scan_reject`).
- `src/lib/chart-days.functions.ts` — CRUD (get by patient+date, upsert hourly cell, list days for a patient), all `requireSupabaseAuth`.
- `src/lib/chart-commit.functions.ts` — takes the confirmed payload and performs the write-through to `patient_observations`, `investigations`, `microbiology_results`, patient systems fields in a transaction (RPC).

### Client layer

- New route `src/routes/_authenticated/patients.$patientId.chart.tsx`:
  - Date picker for chart day (defaults to today), digital replica of the paper chart in two tabs: **Hourly grid** and **Daily assessment**.
  - Every cell is inline-editable (reusing `EditableField`/`EditableSelect` patterns from Demographics), with running `hourly_balance` and `cumulative_balance` auto-calculated.
  - Prominent "Scan paper chart" button.
- New component `ScanChartDialog`:
  - Uses `<input type="file" accept="image/*" capture="environment" multiple>` for mobile camera capture; also accepts drag-drop / gallery uploads.
  - Client-side downscale to ≤2000px longest edge via `<canvas>` + JPEG 0.85 before base64 encoding — reduces payload + strips EXIF/GPS.
  - Immediately posts to `extractChart` server fn; shows a **skeleton preview** (not the photo) while extracting.
  - On response, opens `ScanReviewDialog`: side-by-side (left = extracted fields grouped by section with confidence-coloured badges; right = current chart values). Clinician can accept-all, accept-per-section, or edit inline. Confirm calls `commitChart`.
  - After the response (success **or** error) the base64 payload is cleared from state and never persisted.
- Patient detail: add "Chart" tab in the existing tab strip, pointing to the new route (URL-preserved with the existing `?tab=` pattern).
- Handover columns: the write-through means existing handover renderers automatically get the new obs / investigations / micro / systems text. Add a small "24h balance" line to the observations column when a chart_day exists for the current shift.

### UX flow (mobile-optimised)

1. Clinician opens the patient → Chart tab → taps **Scan chart**.
2. Native camera opens (thanks to `capture="environment"`). Takes one photo of page 1, optionally a second of page 2.
3. Loading state ("Reading chart…") — no image displayed.
4. Review screen — clinician verifies extracted values against the paper in hand (not against a stored image). Can edit any field.
5. Confirm — commit writes structured rows, updates handover-visible fields, records audit.

### Testing

- `tests/chart-extract-schema.test.ts` — mock Gateway response, assert Zod-parsed payload matches expected shape and PII scrubbing removes name/DOB.
- `tests/chart-commit.test.ts` — commit maps hourly[] → `patient_observations` rows with correct timestamps (chart_date + hour), and creates investigations only for ticked boxes.
- `tests/no-image-persistence.test.ts` — grep guard: forbid `storage_upload`, `parsed-documents`, or `fs.writeFile` inside chart-extract.functions.ts; assert the server fn signature never returns image data.
- E2E: seed patient, POST fake extraction payload directly to `commitChart`, open Chart tab and handover PDF, assert values appear.

### Rollout phases

1. Migration + `chart_days` / `chart_hourly` tables + digital chart page (manual entry only).
2. Extraction server fn + Scan dialog + Review dialog (behind an admin-enabled feature flag on `profiles` so it can be piloted).
3. Write-through into existing tables + handover integration.
4. Care-bundle / infusions / assessments extraction + audit review UI on `/admin`.

### Open questions to confirm before build

- Do you want the digital chart to be strictly append-only per hour (nurse enters as the shift progresses) or fully editable retrospectively? (Assumed: editable, mirroring the paper workflow.)
- Should a chart_day auto-close at 08:00 (Salisbury shift boundary) and start a new one, or stay a fixed 00:00–24:00? (Assumed: 00:00–24:00 to match the paper chart headings.)
- Confirm the AI model: default to `google/gemini-2.5-pro` for OCR-quality on handwriting, or prefer `openai/gpt-5.4` for cost/latency?
