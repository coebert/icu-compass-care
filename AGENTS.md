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
- Security headers live in src/lib/security-headers.ts (CSP frame-ancestors allow-lists Lovable preview; no script-src). Why: prevent clickjacking without breaking preview or app boot.
