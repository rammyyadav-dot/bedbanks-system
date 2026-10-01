# ADR 0010: Portals reach the API through a same-origin proxy

## Status
Accepted for Admin, the Agent portal, and the Supplier portal. Supplier organization scope is ADR 0011. The supplier portal proxies `/api/v1` and keeps unsupported modules unavailable.

## Context
The session is an opaque, host-only `HttpOnly` cookie set by the API (ADR 0001). The API trusted exactly one browser origin, `ADMIN_ORIGIN`, in three places: CORS, `OriginGuard` on `/auth/*`, and the global `CrossSiteRequestGuard` on every unsafe method. The Agent portal called the API directly from the browser with `credentials: 'include'`. Deployed on its own address that cannot work: every login or booking is refused with `Untrusted request origin`, and a cookie set by the API host is a third-party cookie for the Agent origin, which `SameSite=lax` does not send and Chrome and Safari block.

Alternatives considered:
- Direct calls plus CORS on a shared parent domain (`api.`, `agent.`, `supplier.`). Needs a custom domain, widens CORS, and every portal shares one API-host cookie, so logging in at one portal replaces the session at another.
- `SameSite=none` cross-site cookies. Depends on third-party cookies that browsers are removing, and weakens CSRF protection.

## Decision
Each portal proxies `/api/v1/*` to the API from its own server (`next.config.mjs` rewrites, destination `API_INTERNAL_URL`), exactly as Admin does. Browser code calls the relative `/api/v1` base. The cookie is therefore host-only on each portal's own origin, so portals cannot overwrite each other's sessions, and no CORS or third-party cookie is involved. A Vercel build of a portal fails without `API_INTERNAL_URL`.

The API keeps rejecting every unsafe request whose `Origin` is not trusted. Trust is now an exact list: `ADMIN_ORIGIN` plus the comma-separated `TRUSTED_ORIGINS` (portal origins, no paths, no wildcards, HTTPS in staging and production, validated at startup). `OriginGuard` and `CrossSiteRequestGuard` both use the list. CORS stays Admin-only because portals never call the API cross-origin. `Sec-Fetch-Site: cross-site` is still refused.

## Consequences
- Adding a portal means: set `API_INTERNAL_URL` on its Vercel project and add its exact origin to the API's `TRUSTED_ORIGINS`. Forgetting the second step fails closed with 403 on login.
- Origin matching is exact: scheme, host and port. Preview deployments have different origins and are not trusted unless listed, so only the production origins should be listed.
- The proxy forwards the browser `Origin` header, so the guard still sees who made the request.
- Agent and Supplier no longer need a public API URL in browser bundles. `NEXT_PUBLIC_AGENT_API_URL` remains an optional override for tests.
- Rollback: remove the rewrite and `TRUSTED_ORIGINS`; the API behaves as before with Admin as the only trusted origin.
