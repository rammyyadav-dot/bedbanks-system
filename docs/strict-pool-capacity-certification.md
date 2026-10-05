# Strict-role pool capacity and attribution: implementation evidence

## Source and scope

Inspection on 2026-10-05 fetched main at `14b9451baecc5dbe7af7a78bf97de5f01326a40b`. GitHub reported PR #261 merged at that commit. This change builds on that implementation; it does not duplicate the editor. During validation, main advanced to `84f9e2c431dafde17ccee41c3ad42eb1bb7075dd` via PR #262. The final branch `fix/strict-role-pool-capacity-certified` is based on that merge and keeps its migration intact. This follow-up narrows the six-column provenance grant to two columns, adds column-ACL convergence and a repeatable-read attribution snapshot.

F01 remains OPEN. Its candidate `aea042299bdc2b7fbc33945b0cb89ba0a7a04238` and expected tree `5f8b30e1472764ec3a9e97a6191dcbd319657294` are untouched. This report is not release-source certification or production authorization.

## SQL and RLS derivation

Inspection used the actual queries in `PoolCapacityService` determine the requirements below. Existing table reads supporting other API paths remain in the shared runtime contract; this mission introduces no general hold read or write.

| Path | Required access | Enforcement |
| --- | --- | --- |
| Hotel/pool authorization, detail | Existing table SELECT on Hotel, InventoryPool, Supplier, InventoryPoolDay (detail loads the complete pool-day ORM row) | Tenant and hotel predicates; forced tenant RLS |
| Membership and former-plan descriptions | Existing SELECT on RatePlan, RoomType, BoardBasis, Contract | Tenant predicates and existing RLS |
| Preview/fingerprint | InventoryPoolDay SELECT: id, tenant_id, pool_id, stay_date, capacity, sold, held, updated_at | Missing days invalid; no write |
| Apply compare-and-set | InventoryPoolDay UPDATE(capacity, updated_at); existing SELECT covers WHERE id, tenant_id, pool_id, capacity, sold, held, updated_at | Stock floor, old values, transaction and advisory locks |
| Idempotency and audit | Existing AuditEvent SELECT and INSERT; no UPDATE/DELETE | Tenant-scoped key lookup, request hash, same transaction as capacity changes |
| Attribution | InventoryHoldNight SELECT(tenant_id, counter_kind, pool_day_id, hold_id, quantity); InventoryHold SELECT(id, tenant_id, rate_plan_id, status) | Join/filter/group columns only; one RepeatableRead snapshot |
| Missing-day creation | No INSERT on InventoryPoolDay | Preview invalid; Apply atomic 422; separately controlled authoring required |

The hold tenant policies use `tenant_id = fbeds_current_tenant_id()` for USING/WITH CHECK (`202609250001`); the pool-day policy does the same (`202610160001`). Their required tenant columns are included. Policies and FORCE RLS are unchanged. The application role is neither table owner, superuser nor BYPASSRLS. Protected identity, stock, source and freshness columns are not writable through this capacity grant.

ADR 0037 compares a separate principal with column grants on the existing API principal and selects the latter for this bounded operation. User read/preview/apply permissions are unchanged; process privileges do not grant users permission. The existing column-only hold reads are required: denial is an operational 503, not fabricated zero consumption. Provisioning and verification handle column ACLs explicitly, including rejection/removal of broader prior grants.

## Validation

Node `24.19.0`, pnpm `10.4.1`, PostgreSQL `16.15`, pgvector `0.6.0`. Dependency installation used the frozen lockfile. All databases and provisioned roles were disposable and local.

| Check | Result |
| --- | --- |
| API unit | 766 passed; 3 Redis-dependent tests skipped (REDIS_URL unset) |
| Full API PostgreSQL/HTTP e2e, fresh cluster | 61 suites, 542 tests passed |
| Strict-role capacity and attribution | Successful HTTP preview/apply/report; direct protected-column writes denied; broad/extra/missing grants detected; missing grants return sanitized 503 |
| Tenant isolation, concurrency, idempotency, stale previews | Passed in e2e |
| Freshness regression | Expired supplier row retains source, source_updated_at, received_at, fresh_until after capacity edit; Agent still returns no sellable offer |
| Migration replay/upgrade and contract parity | Passed in full e2e, including roles present and absent |
| Workspace type-check, lint, architecture and schema guards | Passed; one pre-existing API lint warning |
| Non-API package tests | Passed, including Admin 39 and Agent 96 |
| API and Admin production builds | Passed |
| Workspace production build | Incomplete: Agent Google Fonts fetch failed with EAI_AGAIN for fonts.googleapis.com |
| Production Admin browser against strict-role API | 58/59 checks passed; remaining failure: 6px horizontal overflow at 390px |

The browser success assertion originally raced the table refresh. The harness now waits for the rendered capacity before checking it. No Admin application code was changed. The remaining mobile overflow is recorded, not hidden or counted as a pass. Browser checks cover sign-in, view/edit, stale conflict, double-click, permissions, cross-tenant denial, keyboard and accessibility.

An earlier broad run on a reused disposable cluster aborted with PostgreSQL index corruption (XX002). It was discarded; the passing full run used a newly initialized cluster. This container cannot switch Unix users or use Unix sockets. PostgreSQL startup used an external OS identity shim and TCP in the isolated test environment; Node/API processes did not use that shim, and PostgreSQL SQL role/RLS enforcement remained active. These local results do not certify an ordinary-host operational deployment; CI/normal-host replay remains a release prerequisite. Fixture setup uses a privileged local owner connection; API acceptance uses the separately provisioned non-superuser, non-BYPASSRLS login. No shim, credentials or cluster files are committed.

Commands run included frozen dependency install, Prisma generation and local migration replay, `pnpm type-check`, `pnpm lint`, `pnpm check:architecture`, `pnpm check:schema`, `pnpm --filter @bedbanks/api test:unit`, `pnpm --filter @bedbanks/api test:e2e`, non-API workspace tests, API/Admin builds and `node tools/admin-ops-verify/verify-pool-capacity.cjs`. All pnpm commands used 10.4.1. Role provisioning/verifier calls and negative grants occurred only inside disposable tests. The membership test now owns its extra-role fixture rather than depending on an unprovisioned mapping-reader role.

Quick Update remains a privileged provenance-writing operation: the restricted API returns typed 403 with all pool-night fields unchanged. This is tested through HTTP, not assumed from the grant list.

## Release limits and safety

This is a draft implementation, not approval to widen persistent privileges. Review ADR 0037 and the forward-only privilege migration before a separately authorized code/provisioning rollout. No persistent role provisioning, production migration, deployment, DNS/alias change, booking, payment or live supplier enablement occurred. No Prisma schema changes were made.

```
F01_STATUS=OPEN
STRICT_ROLE_SQL_CERTIFICATION=PASS_LOCAL_DISPOSABLE
BROWSER_ACCEPTANCE=PARTIAL_58_OF_59
WORKSPACE_BUILD=BLOCKED_EXTERNAL_FONT_DNS
PRODUCTION_DB_MIGRATION_EXECUTED=NO
PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO
PRODUCTION_DEPLOYMENT_EXECUTED=NO
DNS_OR_ALIAS_CHANGED=NO
LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO
BOOKING_ENABLED_BY_THIS_WORK=NO
PAYMENT_ENABLED_BY_THIS_WORK=NO
```
