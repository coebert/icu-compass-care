// Security headers for every response. Anti-framing uses CSP frame-ancestors
// (not X-Frame-Options, which cannot allow-list) so the Lovable editor preview
// can still embed the app while any other site is refused. Script/style
// sources are deliberately not restricted: the app relies on framework inline
// bootstrap scripts, and a broken CSP would lock clinicians out.
export const FRAME_ANCESTORS = [
  "'self'",
  "https://lovable.dev",
  "https://*.lovable.dev",
  "https://*.lovable.app",
  "https://*.lovableproject.com",
];

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    `frame-ancestors ${FRAME_ANCESTORS.join(" ")}`,
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

export function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
}
