# Tenant and database security certification

Decision record: [ADR 0068](adr/0068-controller-declared-supply-permissions-and-security-certification.md). Builds on the strict runtime role ([strict-runtime-db-role.md](strict-runtime-db-role.md), ADR 0032) and the per-role verifiers.

**Scope.** Engineering certification on a disposable, loopback PostgreSQL 16 cluster with pgvector and pg_trgm, generated credentials and synthetic fixtures. No persistent database, deployment, credential or production role was touched. This record is not a production release approval: the remaining gates at the end still apply.

The repository is public: this record contains aggregate results only, no connection strings, hostnames or raw logs.

## How to re-run

```sh
# disposable loopback database named fbeds_ci, owner connection, NODE_ENV=test
pnpm --filter @bedbanks/api prisma:migrate:deploy
pnpm --filter @bedbanks/api prisma:migrate:status
pnpm --filter @bedbanks/api prisma:migrate:drift
GITHUB_ACTIONS=true pnpm --filter @bedbanks/api exec node --no-experimental-strip-types -r @swc-node/register scripts/certify-disposable-runtime-role.cjs
pnpm --filter @bedbanks/api ops:certify-tenant-control --disposable-local
pnpm --filter @bedbanks/api test:security          # this certification
pnpm --filter @bedbanks/api test:e2e               # every suite, including concurrency, replay and migration
pnpm --filter @bedbanks/api prisma:migrate:drift    # again, after all suites
GITHUB_ACTIONS=true pnpm --filter @bedbanks/api exec node --no-experimental-strip-types -r @swc-node/register scripts/certify-disposable-runtime-role.cjs
```

CI runs the same sequence in the `Prisma migration certification` job; `test:security` is its own named step.

## What is certified, and where

`apps/api/test/security-certification.e2e-spec.ts` runs the real Nest application on the strict runtime login `fbeds_api_login` (NOBYPASSRLS, forced RLS, `DB_RUNTIME_ROLE_GUARD=enforce`). The owner connection writes fixtures only; every HTTP request and every probe goes through a restricted login.

### 1. Restricted database-role privileges and forced RLS

| Check | How |
| --- | --- |
| Every restricted role passes its own contract while connected as itself | `fbeds_api_login`, `fbeds_booking_ops`, `fbeds_hold_expiry_login`, `fbeds_rateplan_ops`, `fbeds_rateplan_cloner`, `fbeds_compliance_export`; `fbeds_tenant_control_login` by `ops:certify-tenant-control` |
| Every table with `tenant_id` has enabled **and forced** RLS and at least one policy | `certifyDatabaseSecurity`, catalog-wide, not just tables in a contract |
| Every table without `tenant_id` is explicitly classified (child tables must still have forced RLS) | `NON_TENANT_TABLES`; a new unclassified table fails |
| Every policy is scoped by a tenant, user, platform or compliance predicate | no `USING (true)` on tenant data |
| No `fbeds_*` role is SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION, owns a relation or function, or inherits `pg_read_all_data`/`pg_write_all_data`-class roles | catalog |
| No `fbeds_*` role holds TRUNCATE (bypasses RLS), REFERENCES or TRIGGER | catalog |
| No `fbeds_*` role may UPDATE or DELETE append-only tables (`AuditEvent`, `ComplianceRecord`, `ComplianceExportBatchRecord`, `LedgerEntry`, `BookingEvent`, `BookingFinanceEvent`, `BookingSupplierCall`, `BookingDocument`, `ServiceCaseNote`) | catalog; then live UPDATE/DELETE/TRUNCATE of `AuditEvent` as four logins, each refused |
| `users.password_hash` and `sessions.token_hash` readable only by the API runtime | catalog |
| PUBLIC holds no table privilege and cannot create in `public`; SECURITY DEFINER functions pin `search_path` and are not PUBLIC-executable | catalog |
| The certifier detects each violation class | negative controls applied in a transaction, asserted, rolled back |
| No tenant context reads and writes nothing; another tenant is invisible; a forged cross-tenant audit insert is refused | live, as `fbeds_api_login` |
| HTTP runtime cannot write ledger, wallet, booking, daily rates, platform roles, memberships or role grants | `has_table_privilege` as the login |

### 2. Permissions

- **Route inventory.** Every route of `AppModule` is enumerated from Nest metadata and must fall in exactly one class: `public` (allowlist of 4), `self` (5: identity and own capability lists), `guard-permission` (declared key read by the matching fail-closed guard), `booking-scope` (`BookingAccessGuard`), `supplier-membership` (`SupplierOrganizationGuard` plus `supplier.extranet.*` in the service). An unclassified route fails.
- **Zero-permission sweep.** An authenticated, active member of a tenant with no role is sent to every non-public, non-self route: each must answer 403; anonymously each must answer 401. Denials are audited in the caller's tenant.

### 3. Cross-tenant denial (Admin, Agent, Supplier)

Each actor holds the same broad role in its own tenant, so a refusal can only come from tenancy. Each test starts with a positive control on the caller's own data.

| Actor | Refused |
| --- | --- |
| Admin (owner of A) | selecting tenant B by header (403); B's hotel, supplier, hotel setup and booking ids inside A (404); PATCH B's hotel (404, row unchanged); a body `tenantId` of B (400, nothing created); B absent from lists; the denial is audited against A, nothing written into B |
| Agent (A) | selecting B (403); B's published-hotel image, and B's image under A's hotel (404); B absent from audit and context; cancelling B's booking (403, row unchanged). Booking reads stay behind `BOOKING_ENABLED` and are certified by the booking suites |
| Supplier (A) | selecting B (403); B's supplier by `x-fbeds-supplier-id` (403); B's hotel, rooms and booking (404); a room draft on B's room (404, nothing written); B absent from lists; an Admin without a supplier membership gets no extranet (403) |

### 4. Session security

HttpOnly, Secure, SameSite and `Path=/` cookie; only the SHA-256 of the token is stored; identity is read only from the cookie (no session, forged or malformed cookie, bearer token or user header → 401); logout revokes server-side; expired sessions, suspended users and revoked memberships lose access on the next request; unsafe requests from an untrusted Origin are refused before authorization; login failures are generic for unknown and wrong-password accounts and audited without the password.

### 5. Audit logging and privileged write paths

A privileged write (`POST /supply/hotels`) creates exactly one audit event with tenant, actor, action and request id, without secrets. Every refusal from guards is audited. The audit log cannot be updated, deleted or truncated by any restricted login, even within its own tenant.

### 6. Concurrency, replay and migration (re-run)

Re-run unchanged against the disposable PostgreSQL 16 database as part of `test:e2e`, among others: `inventory-hold` (concurrency), `booking-confirmation` (atomic confirmation), `ledger-financial-safety`, `agency-funding`, `supplier-mutation-journal`, `booking-actions` (idempotent replays), `strict-runtime-role-replay` (migration replay/upgrade/provisioning convergence), `strict-role-rollout`, `platform-role-migration`, `database` (migration integration), `inventory-db-integrity`, `runtime-db-guard`. Migration status, drift before and after all suites, and the strict-role re-certification are separate steps.

## Findings and fixes

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| F1 | 74 supply, mapping and rate-plan approval handlers declared no controller permission; the service checked it, but often after validating the body or loading the row, so an unauthorized member got 400/404 instead of 403 (schema disclosure and an in-tenant existence oracle; RLS kept other tenants invisible) | Medium (invariant 2) | Each handler declares the key its service checks with the fail-closed `SupplyPermissionGuard` (ADR 0068). Service checks retained |
| F2 | `PlatformRbacGuard` allowed a handler with no declared permission | Medium (latent; every current handler declares one) | Fails closed; unit spec |
| F3 | Platform routes answer 503, not 403, when `TENANT_CONTROL_DATABASE_URL` is unset, because the runtime role cannot read platform tables | Low (fails closed) | No code change: deployments configure the tenant-control login; the suite does too |

Observations, no change made:

- Sessions have an absolute lifetime (`AUTH_SESSION_TTL_SECONDS`, default 8 h) but no idle timeout; `last_seen_at` is recorded but not enforced. A product decision.
- `fbeds_rls_test`, a NOLOGIN probe role created by several e2e suites with broad DML, exists only on disposable databases. The certifier flags it by default; only this suite names it as a test fixture.
- `tenants` gains forced RLS and its policies from the tenant-control provisioning CLI, not from a migration.
- The legacy `PATCH /supply/hotels/:hotelId` cannot write under the strict role (it rewrites `external_ref`, which the role may not update); Hotel Setup is the strict-role path.

## Results

Run 2026-10-17 on a fresh disposable cluster: PostgreSQL 16.15, pgvector and pg_trgm, Node 22 (CI uses Node 24), branch `claude/affectionate-cannon-yq70c5`.

| Step | Result |
| --- | --- |
| `prisma validate`, `migrate deploy` (80 migrations), `migrate status` | pass; schema up to date |
| Drift before suites | no drift |
| Strict runtime role certification | contract PASS; 26 privilege probes; 41 forced-RLS contract tables; identity `fbeds_api_login` |
| Tenant-control certification (`ops:certify-tenant-control`) | 18/18 |
| `test:security` (this certification) | 27/27 |
| Full API e2e (`test:e2e`, includes every suite in section 6) | 91 suites passed, 1 skipped; 917 tests passed, 18 skipped, 0 failed |
| Drift after all suites | no drift |
| Strict runtime role re-certification after all suites | contract PASS |
| Catalog certifier on the migrated database | 63 tenant tables with forced RLS, 16 classified non-tenant tables, 79 policies, 0 failures |
| API unit tests | 137 suites; 1,506 tests (1,503 passed, 3 skipped), including the new controller and guard specs |
| `type-check`, `lint`, `check:architecture`, `check:schema` | pass |

An earlier run in the same session showed 61 failing suites. That was environmental: the sandbox revoked access to the cluster's data directory mid-run and PostgreSQL aborted. It was discarded, and both later runs were on a cluster outside that directory.

`tools/workflow-lint.test.mjs` needs `actionlint`, which this environment lacks. It fails identically on the base commit. The edited workflow was parsed as YAML instead.

## Remaining gates (not certified here)

Production or clone credentials and role provisioning, backup/PITR and a tested restore, a reviewed maintenance window, owner approval, authenticated deployment smoke tests, and a clone certification run (`docs/clone-certification-runner.md`). Booking, payment and supplier dispatch remain gated.
