# ADR 0108: Admin console session enforcement and ADMIN / SUPER_ADMIN gate

## Status
Accepted for the Admin console. No identity-provider swap.

## Context
The Admin login used to look like a complete sign-in while the edge layer only checked that a session cookie was *present*. An expired, forged or Agent-only cookie could still reach the dashboard shell until a Server Component called `/auth/me`. Direct URLs were gated in the browser (ADR 0063) and by the API, but the console itself did not refuse non-operator memberships (`member`, `finance`).

The brief asked for Cognito or equivalent OIDC session validation, `apps/admin/middleware.ts`, and ADMIN / SUPER_ADMIN RBAC. This repository already chose opaque, database-backed sessions (ADR 0001) and a same-origin portal proxy (ADR 0010, ADR 0055). Next.js 16 renamed `middleware.ts` to `proxy.ts`.

## Decision
1. **Keep opaque sessions.** The Admin console validates the host-only `HttpOnly` cookie against `GET /auth/me` (the API hashes the token and loads the user). That is the equivalent of an OIDC userinfo check: identity is never taken from the browser, a JWT, or a tenant id in the body. Cognito is not introduced.
2. **Edge file.** `proxy.ts` remains the Next.js 16 request entry (API rewrite + cookie shape). `middleware.ts` is absent: Next.js rejects a project containing both conventions, including a re-export-only alias. The edge layer rejects a missing or malformed opaque token (64 hex chars) and sends the caller to `/login`. Full session and role checks stay in Server Components; the edge must not call the API on every static request.
3. **ADMIN / SUPER_ADMIN.** A session may use the console only when at least one *active* membership role maps to `ADMIN` (`owner`, `ADMIN`) or `SUPER_ADMIN` (`SUPER_ADMIN`, `PLATFORM_ADMIN`). Other memberships stay on the Agent portal. The dashboard layout and the login action both enforce this. Tenant switching only lists those admin memberships.
4. **Tenant isolation.** Unchanged at the database: `TenantContextGuard` + `withTenant` + forced RLS + `check:tenant-filter`. Admin server fetches that are tenant-scoped pin `x-fbeds-tenant-id` from the session-resolved membership, never from a client-supplied id.

## Consequences
- An Agent `member` who signs in at Admin is refused and the API session is revoked so the cookie is not left live on the Admin host.
- Adding Cognito later is a separate reviewed IdP change; it must still mint or exchange into the existing opaque session.
- Rollback: revert this ADR's Admin files. API guards and RLS stay in place.

## Verified
Admin unit tests for role mapping, edge cookie shape, login refusal, layout `requireAdminSession`, and tenant-header pinning. Architecture checks including `check:tenant-filter`.
