# ADR 0031: Strict runtime-role contract and fail-closed commercial controls

## Status
Accepted for the API code, tests and one forward migration, replayed only on disposable local databases. Applying `202610170001_strict_runtime_role_contract` to any persistent database is an owner-controlled step (it revokes privileges). One decision stays with the owner and is **BLOCKED**: which principal writes the Admin authoring tables (see "Open decision"). Supersedes ADR 0019 item 9 and ADR 0020 item 5, and refines ADR 0018 and ADR 0013 item 4.

## Context
P0.4 certification found four gaps on the strict API runtime role `fbeds_api` (ADR 0008):

1. **Migration grants and provisioning disagreed.** Eleven migrations carry `GRANT ... TO fbeds_api` guarded by "if the role exists". A database whose role existed before those migrations ran held INSERT/UPDATE/DELETE on Admin authoring tables (agencies, restrictions, markup rules, approvals, hotel profile and images, inventory pools, `SupplierMutation`); a database migrated first did not. Provisioning (`REVOKE ALL`, then the contract grants) silently reverted them. Two databases at the same migration could hold different privileges.
2. **Mandatory commercial reads were not in the contract.** The role could not read `Agency`, `AgencyMember`, `DistributionRestriction` or `CommercialMarkupRule` when provisioned strictly, and four code paths turned that into a log line and carried on: no suspension check, no restrictions (every hotel visible to a restricted agency), no markup rules.
3. **A grant mismatch surfaced as an unclassified 500.** An authorized Admin caller whose request needed a write the role does not hold got `INTERNAL_SERVER_ERROR`, indistinguishable from a bug.
4. **Production-clone compatibility is still BLOCKED** (no approved clone, secrets or runner). Not addressed here.

The principal is the same for every HTTP request: `PrismaService` connects with `DATABASE_URL`, which in a strict deployment is `fbeds_api_login`. Hold expiry uses the separate `fbeds_hold_expiry_login`. Nothing in the API switches principal per route.

## Decision

### 1. One contract, enforced three ways
`apiRuntimeGrantStatements()` is the single source of truth for what `fbeds_api` holds.

- **Reads added:** `Agency`, `AgencyMember`, `DistributionRestriction`, `CommercialMarkupRule` (mandatory commercial controls). Pool tables stay SELECT only.
- **Writes (exhaustive allowlist, `API_RUNTIME_WRITE_ALLOWLIST`):** `users` (UPDATE `last_login_at`, `updated_at`), `sessions` (INSERT, UPDATE `last_seen_at`, `revoked_at`), `AuditEvent` (INSERT), `supplier_room_drafts` (INSERT, UPDATE). Nothing else, no DELETE or TRUNCATE anywhere.
- **Forward migration** `202610170001_strict_runtime_role_contract` (conditional on the role existing; a no-op on a fresh replay): `REVOKE ALL` on the sixteen Admin authoring tables, then `GRANT SELECT` on the six contract reads. After it, migration-time state equals provisioned state in either order.
- **Verifier** `verifyApiRuntimeRole` now fails on any write privilege outside the allowlist (table or column level, from the catalog, whichever migration granted it) and on any missing contract read.
- **Future migrations** must not grant to `fbeds_api` (spec `SR-07`). Provisioning is the only source of grants.

### 2. Required versus optional controls, and their defaults

| Control | Required for | Valid absence (documented default) | Unreadable / denied / malformed |
| --- | --- | --- | --- |
| Agency membership + status (`AgencyMember`, `Agency`) | Every Agent route that is not `AllowWhenAgencySuspended` | No membership: not suspended | 503 `COMMERCIAL_CONTROL_UNAVAILABLE` |
| Distribution restrictions | Search, recheck (hold rechecks) | No agency or no ACTIVE restriction: none applied | Search → `provider_unavailable` with no offers; recheck → 503 `provider_unavailable`; reason `commercial_control_unavailable` in the audit record. A restriction row naming no target is malformed and fails the same way |
| Markup rules | Only when a NET rate is in play (a SELL rate needs none) | No ACTIVE rule: NET rates unsellable, `NET_RATE_MARKUP_UNAVAILABLE` (ADR 0018) | Search → `provider_unavailable`; recheck → 503. Rows with out-of-range basis points, an invalid date or a scope with no target are malformed and fail the same way |
| Hotel images (search `primaryImage`) | Nothing: optional content | Hotel returned without image | Hotel returned without image, warning logged (leaving an image out never misleads, unlike a price) |

Unreadable never becomes unrestricted eligibility, zero markup or a successful quote. The internal reason is `CommercialControlUnavailableError` (control, `denied | failed | malformed`, SQLSTATE). A structured JSON diagnostic with the request id is logged; the response carries no SQL, table name or connection detail.

The search and hold response contracts (`provider_unavailable`) are unchanged; the distinction from a supplier failure is internal (audit `reason`, log `control`). The suspension guard uses the existing `{message, code}` exception shape with the new code `COMMERCIAL_CONTROL_UNAVAILABLE`.

### 3. Error semantics for Admin mutations
- Authentication → 401. RBAC → 403 `FORBIDDEN` before any write (the guards and per-service permission checks run first); the intentional `permission.denied` audit event is preserved. Another tenant's resource → 404 (existing non-disclosure).
- A PostgreSQL `42501` reaching the global filter for an otherwise authorized request is **configuration, not authorization**: sanitized 503 `DATABASE_ROLE_NOT_PERMITTED`, structured diagnostic (SQLSTATE, method, path, request id; no table names). It is never mapped to 403. Row-level-security violations (also `42501` class but a different message) stay unclassified 5xx until an owner path needs them classified.
- Reads keep the existing `OPERATIONS_READ_DENIED` 503.

## Open decision (human-owned, BLOCKED): which principal writes the Admin authoring tables
ADR 0008 and 0013 place Admin writes outside the API role's grants but name no writer, and the Admin app calls the same API process. Until it is decided, Admin authoring mutations on a strict deployment answer 503 `DATABASE_ROLE_NOT_PERMITTED` and change nothing. Nothing here widens access. Options, least privilege first:

- **A (recommended).** A separate NOLOGIN group `fbeds_admin_api` and login, used by a second connection (an Admin API deployment, or an explicit second Prisma client for `/admin/*` mutation routes). Its write set is exactly the table in `docs/p05-strict-runtime-role-contract.md` ("Candidate Admin write set"), each table under forced RLS and the existing per-route permission guards. Needs: provisioning and verifier for the new role, a connection per principal, ADR.
- **B.** Keep Admin authoring as an operator action through a privileged owner-side path (maker-checker already exists for the sensitive rows), and keep the Admin UI read-only on strict deployments.
- **C (rejected).** Grant the writes back to `fbeds_api`. Enlarges the blast radius of the process that serves Agent traffic and contradicts ADR 0008.

Also awaiting the owner: whether the Agent hotel-image route should read `HotelImage` on the strict role (read-only, forced RLS; today it answers 503 `DATABASE_ROLE_NOT_PERMITTED` there), and the agency credit-limit read for holds (holds also need `InventoryHold` writes that `fbeds_api` does not have, so the hold path is not served by this role).

## Consequences
- A strict deployment now needs `fbeds_api` provisioned **after** this migration, or re-provisioned, so the four control reads exist; without them every Agent route that checks suspension and every search refuses (a deliberate, visible outage rather than a silent unrestricted one). `verifyApiRuntimeRole` reports the missing reads by name.
- A provisioned role that still carries a migration-era write is reported by the verifier and removed by provisioning or the migration.
- Rollback of the migration: owner re-grants per table (listed in its header). Rollback of the code: revert the commits; no schema, index, RLS or data change was made.
- Tenant isolation, RLS and RBAC are unchanged. Every new read is under forced RLS and was tested for own-tenant success, cross-tenant empty and no-context empty.
