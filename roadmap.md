# Roadmap — workflow review (Nov 2026)

- [ ] 1. Partner bed board: count withheld patients as occupied, fail closed on uncertain data, add generated_at
- [ ] 2. Inbound sync: separate failed writes, partial failure = not ok, empty pulls heartbeat, reject malformed feeds, no raw error text
- [ ] 3. Sync status: per-resource latest attempt + latest success, no invented next run, accessible details, safe retry
- [ ] 4. Bed board page: load failure / empty / filtered / stale states; no vacant beds from failed or filtered data
- [ ] 5. Referral prefill: accessible error/retry/empty/loading; stale-preview compare-and-set on apply
- [ ] 6. Tests (synthetic only), typecheck, build; report (do NOT publish)
