# RLS Access Rules — Clinical Sub-Tables

Final, authoritative access model for the four patient clinical sub-tables.
Keep this in sync with any migration that touches their policies. Regression
coverage lives in `tests/security/run-security-scan.sh` (notably
`tests/e2e/rls-fixed-policies-block-public-enforce-clinical.e2e.py`), which is
run by the **Security findings scan** CI job and fails the build if this scope
is ever widened by accident.

## Tables covered

- `public.handover_acknowledgements`
- `public.patient_lines`
- `public.patient_tasks`
- `public.patient_reviews`

## The rule (identical across all four)

Every operation is restricted to authenticated clinical staff. There is **no
public/anon access** and **no bare `true` policy** anywhere on these tables.

| Operation | Role            | Condition                                 |
| --------- | --------------- | ----------------------------------------- |
| SELECT    | `authenticated` | `private.has_clinical_access(auth.uid())` (`USING`)      |
| INSERT    | `authenticated` | `private.has_clinical_access(auth.uid())` (`WITH CHECK`) |
| UPDATE    | `authenticated` | `private.has_clinical_access(auth.uid())` (`USING` + `WITH CHECK`) |
| DELETE    | `authenticated` | `private.has_clinical_access(auth.uid())` (`USING`)      |

### Who this grants / denies

- **Anonymous (publishable key, no JWT):** no read, no write. RLS filters all
  rows out and rejects every write.
- **Signed-in non-clinical user (no `user_roles` row):** no read, no write.
  `private.has_clinical_access` returns false, so rows are invisible and writes
  are rejected (401/403 or accepted-but-zero-rows, never persisted).
- **Signed-in clinical user (`clinician` or `admin` role):** full read/write.

`private.has_clinical_access(uuid)` is a `SECURITY DEFINER` function in the
`private` schema that returns true when the user holds a clinical role in
`public.user_roles`. Roles are **never** stored on `profiles` — see project
memory.

## Grants (Data API prerequisite)

RLS is not enough on its own; the Data API also needs table GRANTs:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO authenticated;
GRANT ALL ON public.<table> TO service_role;
-- NO anon grant: every policy scopes to an authenticated clinical user.
```

`service_role` (used by server functions / bridge code via the admin client)
bypasses RLS by design and is the only path for trusted server-side access.

## Rules for future changes — do not break scope

1. **Never** add a policy for the `anon`/`public` role on these tables.
2. **Never** use `USING (true)` / `WITH CHECK (true)`; always gate on
   `private.has_clinical_access(auth.uid())`.
3. **Never** grant any privilege to `anon` on these tables.
4. Keep `role` = `authenticated` explicit on every policy (not `public`).
5. When adding a new operation or table in this clinical family, mirror this
   exact pattern (SELECT/INSERT/UPDATE/DELETE, all four gated the same way).
6. After any migration touching these tables, run
   `bash tests/security/run-security-scan.sh` locally — CI runs it too and the
   build fails if the access scope regresses.
