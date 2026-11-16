# Roadmap — coordinated Hub/CCC fixes (Nov 2026, not published, migrations staged only)

- [ ] A1. Inbound client: CCC sync v1 paged contract for referrals/investigations/microbiology; strict validation, budgets, safe errors
- [ ] A2. Patients source_owned here: remove CCC->Hub patient bulk upsert; status shows "Managed in Handover Hub"
- [ ] A3. Referrals allowlist + revision compare/CAS + tombstones (no hard delete), trigger-safe timestamps
- [ ] A4. Investigations/microbiology: new ids only, existing shared Radnor patient, conflict on divergence, write-boundary sharing check
- [ ] A5. Reconcile + audit/notifications read paths: no bypass; legacy {records} parsed strictly
- [ ] B1. Bed payload unit_code
- [ ] B2. GET bridge/patients: Radnor + shared always; ?id=UUID
- [ ] B3. POST bridge/patients: partial updates by id; Radnor-scoped reads/re-read/update
- [ ] C. Prefill: preserve false; no proxy decisions; labelled referral text
- [ ] D1. updatePatient atomic CAS
- [ ] D2. Staged SQL: normalized active-bed unique index + move/swap RPC (+undo); not applied
- [ ] D3. assertBedFree unit-scoped normalized; board UI uses RPC, no two-write fallback
- [ ] V. Tests (offline + isolated DB), UI fixtures phone/desktop, typecheck/build, report
