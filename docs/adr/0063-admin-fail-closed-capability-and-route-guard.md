# ADR 0063: Admin fail-closed capability gating and central route guard

Status: **Built (Admin UI only; no API, schema or contract change).**

## Finding
- `useCan()` returned true while capabilities were loading and after a failed load (`!known || has`), and the provider never reset when the active tenant changed. Privileged controls could render before session/tenant state had synchronised, and a multi-tenant user could briefly see the previous tenant's permissions.
- The sidebar hid modules the caller could not use, but a direct URL still rendered the page shell. A second, unused permission vocabulary (`lib/auth/permissions.ts`) diverged from the one the API returns.

## Decision
1. **Fail closed.** `lib/auth/capability-policy.ts` allows a control only when capabilities are `ready`, were loaded for the *currently active* tenant, and include the permission. Loading, error and tenant mismatch all deny. `CapabilityProvider` is keyed by tenant, resets on change and ignores stale responses.
2. **One route guard.** `RouteGuard` (in `AdminShell`) resolves a route's required permission from the department catalogue in `@bedbanks/contracts` (through the navigation, longest match) and shows checking / unavailable / denied states instead of the page. Sidebar and URL access now use the same source.
3. **One vocabulary.** The unused `AdminPermission` helper was removed.

## Unchanged (deliberately)
The API remains the authorization boundary: every endpoint re-checks its permission and `TenantContextGuard` revalidates `x-fbeds-tenant-id` against the user's membership and RLS. Tenant identity is not derived in the browser or the Admin proxy (CLAUDE.md invariant 1); the Admin proxy still only checks cookie presence.

## Consequences
Gated controls and nav items are hidden until permissions load, and stay hidden if the capability call fails (the page shows a "could not be verified" message). Routes with no declared permission in the catalogue are not gated by the guard; their API calls enforce access.

## Verified
Admin unit tests (110 pass), type-check, lint, production build. **Not run:** browser walkthrough and Postgres e2e suites (no database or browser session here).

## Not done / next
- A retry control on the "could not be verified" state.
- Declare a permission for `/inventory` in the catalogue so the guard covers it.
