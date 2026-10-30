# Security remediation: deployment sequencing

Database migrations 0002 and 0003 are applied live. The published frontend is still the old build.

## Old frontend + new database (current state)
- Session lock: the old client never creates server-side session guard rows, so `session_active()` stays true. No clinician is locked out. The server idle/lock limit only applies to sessions using the new client.
- Handover history: legacy combined snapshots are restricted to Trust admins. On the old client, clinicians see an empty history list until the new client (per-unit snapshots) is published. Live handover screens are unaffected.
- Passkey unlock: still works. The old client writes its own challenge, which is allowed for active sessions.
- Passkey enrolment: needs a sign-in in the last 10 minutes. Otherwise it fails with a permission error. Workaround: sign out and back in, then add the passkey.
- First-admin claim: sealed.
- Audit writes: unchanged for active sessions.

## Publish, then apply a follow-up migration (pending, not applied)
After the new frontend is live and old tabs have refreshed:
```sql
DROP POLICY "Active sessions write own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY "Active sessions update own challenges (legacy client)" ON public.webauthn_challenges;
REVOKE INSERT, UPDATE ON public.webauthn_challenges FROM authenticated;
DROP POLICY "Reauthenticated active sessions enrol own passkeys" ON public.webauthn_credentials;
REVOKE INSERT ON public.webauthn_credentials FROM authenticated;
```
The new server only issues and consumes challenges and credentials with the service role, so this change has no effect on new clients.

## Known platform constraints
- Access tokens stay cryptographically valid until they expire (about 1 hour). The lock is enforced in RLS and server functions through `session_active()`, not by revoking the token.
- Re-authentication evidence is the `amr` timestamp in the signed token. A password confirmation starts a new auth session.
