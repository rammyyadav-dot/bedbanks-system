# FBEDS API — Authentication (P0-D)

Opaque, database-backed sessions — not JWT. Two decisions worth recording:

## Why opaque sessions, not JWT

Per the CTO directive for this phase: immediate revocation (kill a
session and it's dead everywhere, no waiting for a token to expire),
no refresh-token architecture needed yet, and a much simpler mental
model for reasoning about "is this request actually authenticated"
when most of the system is still being built by AI-assisted, non-expert
review. JWT can be evaluated later if FBEDS grows external API/client
requirements that need stateless verification.

## Why bcryptjs instead of Argon2id

The spec's preferred choice is Argon2id, with explicit permission to
use "an appropriate well-maintained alternative" if the runtime makes
Argon2 operationally unsuitable, as long as the decision is documented
— this is that documentation.

`argon2` (the standard Node package) ships a compiled native binary,
fetched from a CDN at install time. This repo already hit exactly that
class of problem with Prisma's schema-engine binary (also
network-fetched, also blocked in the sandbox this was built in) — a
second native-binary dependency would hit the identical wall. bcryptjs
is pure JavaScript, no compiled binary, nothing to download at install
time. It was also already in use from the (now-superseded) JWT-based
P0-D pass, so this isn't a new dependency being introduced without
precedent.

If a future environment has reliable access to Argon2's binary CDN and
the team wants Argon2id's stronger memory-hardness guarantees, this is
a contained swap: `AuthService`'s `hashPassword`/`verifyPassword`
methods are the only places bcrypt is called.

## What's NOT enforced yet

Tenant isolation (P0-E) and RBAC (P0-F). `GET /auth/me` returns every
active membership the authenticated user has — nothing yet restricts
which tenant's data a request can touch. Every route built after this
phase that reads/writes tenant-scoped data needs an explicit tenant
guard before it can be trusted; that guard doesn't exist yet.

## Current-main hardening (2026-09-16)

The old scope description above predates the existing Agent tenant/RBAC guards and formal permission tables. Those guards are present on current main; this patch does not certify their complete authorization coverage or introduce a platform-admin role policy.

- Tokens: 32 random bytes encoded as hex, only SHA-256 stored in PostgreSQL. Malformed tokens are rejected before querying. Expired, revoked and suspended-user sessions fail validation.
- Cookies: HttpOnly, Secure, host-only, Path=/, SameSite=Lax by default. AUTH_COOKIE_SECURE must be true even in development; use HTTPS for browser testing. No JWT or JavaScript-readable token storage.
- POST /auth/login and /auth/logout require Origin exactly equal to ADMIN_ORIGIN, including trusted server callers. GET /auth/me uses the session cookie. Successful auth responses use Cache-Control: no-store.
- Admin uses Server Actions. Its server explicitly consumes the API Set-Cookie header and sets the Admin host cookie. Server-side fetch alone does not copy cookies to the browser. API_INTERNAL_URL is server-only; AUTH_API_ORIGIN must match ADMIN_ORIGIN. No raw token appears in action results or client props.
- Logout revokes in the API before deleting the Admin cookie. A failed revocation reports failure and retains the cookie so the user can retry. Sessions have an absolute TTL; activity tracking does not extend it.
- API default port is 3002; Admin is 3001. Update existing environment overrides as well as templates. Agent or other server-side auth callers must also forward the trusted Origin for login/logout; they are outside the Admin integration scope.

## Verification and release gate

See docs/P0D-VALIDATION.md from repository root and prisma/MIGRATIONS.md in this app. HTTP and Admin tests use database/fetch doubles and must not be presented as PostgreSQL or browser E2E coverage. Migration 3 duplicates previous SQL; deployment is blocked until actual migration history is reconciled. Login throttling/distributed abuse protection is not added by this patch and remains a production security task.
