# Roadmap — coordinated Hub/CCC fixes (Nov 2026, not published, migrations staged only)

- [x] A1. Inbound client: CCC sync v1 paged contract; strict validation, budgets, safe errors
- [x] A2. Patients source-owned here; no CCC->Hub patient bulk upsert
- [x] A3. Referrals: allowlist, provenance (source vs receiver revision), CAS, minimal tombstones, atomic audit
- [x] A4. Investigations/microbiology: new ids only, shared Radnor patient, conflict on divergence, unit resolved in SQL
- [x] A5. Reconcile + legacy review feeds: explicit bound, refuse possibly truncated data
- [x] B1. Bed payload unit_code
- [x] B2. GET bridge/patients: Radnor + shared; ?id=UUID
- [x] B3. POST bridge/patients: partial updates need caller's expected_updated_at; wardable fields refused
- [x] B4. Fenced wardable endpoint + staged bridge_set_wardable + protocol doc
- [x] C. Prefill: preserve false; explicit decisions only by confirmation; linked referral only; Open in CCC link
- [x] D1. updatePatient atomic CAS
- [x] D2. Staged bed SQL with in-transaction audit; app no longer audits separately
- [x] D3. Unit-scoped normalized bed checks; board uses the RPC only
- [x] E. Optional: safe sync status for clinical members of the bridge unit
- [x] V. Offline tests, isolated PGlite + throwaway PostgreSQL races, typecheck, build, lint
- [ ] V2. Visual phone/desktop check of the referral dialog — blocked: the only running preview reads the live clinical database
- [ ] R. Apply staged 0005–0007, publish, enable CCC — waiting on the owner's release gate
