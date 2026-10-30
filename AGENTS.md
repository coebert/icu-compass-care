<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Sensitive account/credential actions require server-checked recent reauth (JWT `amr`) plus an active session; the client wraps calls in `withReauth` (src/lib/reauth.ts). Why: a locked or stolen session must not change credentials.
- WebAuthn challenges/credentials are written only by server code via the service role, bound to user+session+purpose+expiry. Why: browser-written rows must never unlock a session.
- Security headers live in src/lib/security-headers.ts (CSP frame-ancestors allows only exact Lovable editor origins; no script-src). Why: prevent clickjacking without breaking preview or app boot.
- Role and unit-membership changes go only through `admin_replace_user_roles` / `admin_set_unit_access` (lock first, then session + reauth + reason + scope + suspension checks, audit in the same transaction). Why: TS-only checks could be bypassed via the Data API.
- Session state errors are "unknown" and fail closed (src/lib/session-lock.ts); a lock is only shown after server confirmation, otherwise sign out. Why: never claim protection that failed.
- Tests that touch the connected live backend are excluded unless ALLOW_LIVE_BACKEND_TESTS=1 (vitest.config.ts). Why: no staging copy exists.
