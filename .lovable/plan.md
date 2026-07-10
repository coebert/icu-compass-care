## ICU Handover App — Salisbury District Hospital

A secure, login-only clinical handover tool for tracking ICU patients (and outlying referrals), their history, management, investigations, and outstanding tasks — with full audit-friendly history retained after discharge.

### Access & security model
- **Login required for everything.** No data is reachable without an authenticated session. All patient routes sit behind an authenticated layout.
- **Admin creates all accounts.** No public signup. First admin is seeded; admins create staff accounts and assign roles (`admin`, `clinician`). Roles stored in a separate `user_roles` table (never on the profile) to prevent privilege escalation.
- **Encrypted at rest + strict access control.** Data stored in Lovable Cloud (Postgres) — encrypted at rest, HTTPS in transit — with Row-Level Security so only authenticated staff can read/write. This keeps records fully searchable and editable (the standard, safe model for clinical web apps). Leaked-password protection enabled.
- **Full audit trail.** Every create/edit is stamped with author + timestamp; nothing is hard-deleted.

### Core data model (tables)
- `profiles` — staff display name, linked to auth user.
- `user_roles` — role per user (admin/clinician).
- `patients` — core record: name/identifier (NHS/hospital number), DOB, location type (`icu` | `outlier`), ward/bed, **status** (`referred`, `admitted`, `discharged`, `died`), discharge destination, date of death, admission date.
- `patient_details` — narrative fields, all editable: past medical history, current admission summary, current management, outstanding tasks.
- `escalation_plans` — treatment escalation plan in place? (yes/no) + details.
- `resuscitation` — DNACPR decision made? (yes/no) + details/date.
- `next_of_kin` — name, relationship, contact, **last updated/spoken to** timestamp + who updated them.
- `investigations` — every entry saved with `category` (Bloods, CXR, CTAP, CT chest, CT head — extensible), result/findings text, result datetime, author. "Most recent per category" is derived by query, so nothing is overwritten.
- All tables get GRANTs + RLS policies scoped to authenticated users.

### Screens
1. **Login** — username/password only; no signup link.
2. **Patient board (home)** — list of current ICU patients + separate section for outlying/referred patients. Filter by status. Quick view of status, escalation/DNACPR flags, outstanding tasks.
3. **Patient detail** — tabbed:
   - Overview (history, admission, management, tasks)
   - Escalation & Resuscitation (TEP + DNACPR)
   - Next of Kin (with last-contacted)
   - **Investigations** — "Most recent" cards (Most recent bloods, CXR, CTAP, CT chest, etc.) plus a full chronological log; add new results.
   - Status control — change status, record discharge destination or death.
4. **Admin** — create/manage staff accounts and roles (admin only).
5. **Discharged/archive view** — retained records remain viewable and editable after discharge/death.

### Shared backend / interfacing with the other app
You chose a **shared backend/database**. To make both apps read/write the same records, both Lovable projects must connect to the **same** Lovable Cloud / Supabase backend. This app will enable Lovable Cloud and build the schema above; connecting your other project (a8eeeba1…) to this same backend is a project-linking step done via the Supabase integration.

> Note: I can't reach the other project's backend from here. In the technical section I outline the two viable paths so you can pick when we build.

### Technical notes
- **Stack:** TanStack Start + Lovable Cloud (Postgres, Auth, RLS). Auth via `_authenticated` route layout; bearer-token middleware for server functions.
- **"Username" login:** Supabase Auth is email-based; we implement usernames by mapping each username to an email under the hood (or use email addresses directly if you prefer). Confirm which at build start.
- **Investigations "most recent":** stored append-only; latest-per-category via `DISTINCT ON (category) ORDER BY result_at DESC` in a server function — full history preserved.
- **Shared-DB options for the other app:**
  1. Connect both projects to one Supabase project (true shared tables) — needs the Supabase integration linked to the same instance in both apps.
  2. If they must stay separate backends, expose secured `/api/public/*` endpoints (signature-verified) for data exchange instead.
- **Encryption clarification:** at-rest + TLS + RLS (not zero-knowledge), per your choice — keeps search/edit/sync working.

### Build order
1. Enable Lovable Cloud; set up auth + admin-only account creation + roles.
2. Schema + RLS + GRANTs for all tables; seed first admin.
3. Login and authenticated app shell.
4. Patient board (ICU + outliers) with status.
5. Patient detail tabs (overview, escalation/DNACPR, NOK, status).
6. Investigations tab with "most recent" views + full log.
7. Admin account management.
8. Discharge/archive views; ensure everything editable.
9. Document the shared-backend link path for the other project.

### Open items to confirm at build start
- Username-based login vs. email login.
- Patient identifier field(s) to use (NHS number, hospital number, or both).
- Which shared-backend path (same Supabase project vs. API exchange) for the other app.
