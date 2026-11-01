# ADR 0086: Admin tenant switcher with server-validated selection

Status: **Built (Admin UI only; no API, schema or contract change).**

## Context
ADR 0063 left multi-tenant users on an owner-first default. `TenantContextGuard` already re-validates `x-fbeds-tenant-id` against the session's memberships, a fresh database membership check, tenant status and RLS on every request, and audits `tenant.context.selected`. So the API is the isolation boundary; what was missing was a way for Admin to *persist a choice* that is itself validated server-side rather than held in client memory.

## Decision
1. The selection is an httpOnly, Secure, SameSite=Lax session cookie (`fbeds_active_tenant`, overridable by `ACTIVE_TENANT_COOKIE_NAME`), written only by the `switchTenantAction` Server Action. The cookie holds a tenant id, not a secret.
2. The action loads the identity fresh from `/auth/me` (never from client-supplied data) and refuses any tenant that is not one of those memberships, then redirects to `/dashboard` (a record opened under the previous tenant does not exist in the new one).
3. The dashboard layout treats the cookie as untrusted input: `resolveActiveTenantId` honours it only if it is still a current membership, else falls back to the owner-first default. A stale, tampered or revoked value therefore degrades to the default instead of failing or leaking.
4. `AdminShell` receives the resolved id from the server (it no longer picks its own), seeds the browser `x-fbeds-tenant-id` header and capability provider with it, and keys the page tree by tenant so client state from the previous tenant is dropped.
5. The cookie is deleted on login and logout so a selection never crosses sessions.
6. `TenantSwitcher` appears in the user menu (and the hotel header's account menu) only for users with two or more memberships.

## Security notes
- A forged cookie or header cannot widen access: the API rejects any tenant outside the session's memberships and RLS scopes the data.
- Switching is a context selection, not a privileged mutation; each subsequent API call is audited by the guard (`tenant.context.selected`). No new audit event or idempotency key is needed.
- Server Actions carry Next.js' built-in same-origin check, which covers cross-site forging of the switch.

## Not done / known limits
- The switch only affects browser calls that go through `activeTenantHeaders()`. Admin Server Components use platform-level routes with no tenant header (`lib/data/server.ts`); any future tenant-scoped server fetch must read `readSelectedTenantId()` and pass it through `resolveActiveTenantId`.
- A suspended tenant stays selectable; its API calls are denied by the guard and the shell shows its "could not be verified" state until the user switches.
- No browser or Postgres e2e run (no API/session available here); covered by unit tests, type-check, lint, architecture checks and the production build.
