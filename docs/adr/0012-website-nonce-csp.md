# ADR 0012: Nonce-based Content Security Policy for the website

## Status
Accepted for code review. Production browser verification was run locally against a started production build; verification on Vercel is outstanding (see Consequences).

## Context
The website CSP was a static header with `script-src 'self' 'unsafe-inline'`, which defeats most of CSP's XSS protection. Next.js inline bootstrap scripts need either `'unsafe-inline'` or a per-request nonce.

## Decision
`proxy.ts` generates a 128-bit random nonce per document request, builds the policy with `lib/csp.ts`, sets it on the request (so Next.js applies the nonce to framework scripts and inline styles while rendering) and on the response. Production policy: `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `unsafe-inline` or `unsafe-eval`), `style-src 'self' 'nonce-…'`, no third-party origins (the Vercel Analytics script is first-party at `/_vercel/insights/script.js`), `connect-src 'self'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`. Development adds only `'unsafe-eval'` and `ws:`/`wss:`. The static CSP in `next.config.ts` is removed because two policies would be intersected. Metadata and asset routes are excluded in the proxy matcher. The root layout awaits `connection()` so every page renders per request.

## Consequences
- **Static rendering is lost.** All 18 HTML routes changed from static (prerendered) to dynamic. Pages are rendered on demand on every request.
- **Caching:** HTML responses carry `Cache-Control: private, no-store, max-age=0, must-revalidate`, so no CDN or browser shared cache stores a document containing a live nonce. Static assets under `/_next/static` stay immutable and cacheable. A CDN can no longer serve the HTML without invoking the origin.
- **Latency and cost:** each page view costs a serverless function invocation and adds render time to time-to-first-byte (not measured here). The site is small and mostly text, so rendering is cheap, but invocation count scales with traffic and bots. Edge rate limiting (see the website README) bounds abuse.
- **Verification gaps:** the Vercel Analytics script was observed being requested and allowed by the CSP (a local 404 appears only because the `/_vercel` route does not exist outside Vercel). Whether analytics events are recorded on Vercel is unverified.
- Alternatives rejected: hash-based CSP (Next inline script contents change per request), keeping `'unsafe-inline'` (no real script protection).
- Rollback: restore the static header in `next.config.ts` and delete the nonce code in `proxy.ts`, `lib/csp.ts` and the `connection()` call.
