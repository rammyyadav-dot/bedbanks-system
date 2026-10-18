# ADR 0068: Controller-declared supply permissions and tenant/database security certification

## Status
Accepted. Changes three supply controllers, two guards, adds a read-only catalog certifier and an e2e certification suite. No schema, migration, grant or runtime-role change.

## Context
A certification pass (docs/tenant-database-security-certification.md) ran every HTTP route of the API as an authenticated tenant member who holds no permission. Every route answered 403, with two exceptions:

1. **Supply, mapping and rate-plan approval routes** (74 handlers in `SupplyController`, `MappingController`, `RatePlanApprovalController`) declared no permission at the controller. Each service checked the right `supply.*` key, but many checked it only after validating the body (400) or loading the row (404). An unauthorized member could therefore learn the input schema and probe which ids exist in their own tenant. RLS still kept every other tenant invisible, so nothing crossed tenants, but CLAUDE.md invariant 2 ("every tenant-scoped API controller declares and verifies a permission") was not met.
2. **`PlatformRbacGuard` failed open.** A handler behind it with no `@RequirePlatformPermission` was allowed (`if (!required) return true`). Every current platform handler declares one, so nothing was exposed, but the next handler that forgot would have been. Every other RBAC guard in the API fails closed.

## Decision
1. Each of those 74 handlers declares the same key its service already checks, with the existing `@RequireSupplyPermission(...)` and the fail-closed `SupplyPermissionGuard`. The guard runs before pipes and services, so an unauthorized caller gets 403 before any validation or lookup and the denial is audited. The service checks stay as defence in depth. No permission name is added or renamed.
2. A calendar edit (`POST /supply/calendar/preview|apply`) needs `supply.rates.manage` for rate rows and `supply.availability.manage` for availability rows, which only the body says. `RequireSupplyPermission` now accepts several keys meaning "any one of them"; the guard admits a caller holding one and the service still enforces the exact key per row type. A single key is stored exactly as before, so existing metadata assertions are unchanged.
3. `PlatformRbacGuard` fails closed when no permission is declared.
4. `certifyDatabaseSecurity` (`apps/api/src/database/security-certification.ts`) proves database-wide properties no single role contract states: forced RLS on every `tenant_id` table, an explicit classification for every table without one, scoped policies, no privileged or object-owning `fbeds_*` role, no TRUNCATE/REFERENCES/TRIGGER, no rewrite of append-only tables, credential hashes readable only by the API runtime, no PUBLIC grants, pinned `search_path` on SECURITY DEFINER functions. It reads catalogs only.
5. `test/security-certification.e2e-spec.ts` (`pnpm --filter @bedbanks/api test:security`, its own CI step) provisions every restricted role, verifies each as itself, runs the certifier with negative controls, classifies every route (an unclassified route fails), sweeps every route as a zero-permission member, and tests cross-tenant denial for Admin, Agent and Supplier plus session and audit controls, all through the strict runtime login.

## Consequences
- A new supply handler without a declared permission fails the controller unit spec and the route classification in the certification suite.
- A new table carrying `tenant_id` without forced RLS, or a new table without `tenant_id` that nobody classified, fails certification.
- A caller holding the service key but missing it at the guard is impossible by construction: the declared key is the one the service checks (`supply.controllers.spec.ts` enforces read/manage pairing).

## Rollback
Revert the three controller files, the two guard edits and their specs. The certifier and the e2e suite are additive and can stay or go independently.
