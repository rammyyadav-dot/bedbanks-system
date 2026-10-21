# ADR 0079: Narrow database role for supplier ingestion

Status: Accepted (role, provisioning, certification and connection class; no process uses it yet)
Date: 2026-10-21

## Context
ADR 0078 stores normalized feeds as observations and lists the four tables as privileged paths: the strict API runtime role (ADR 0032) must not
write them, and no other principal existed. The audit insert policy also refuses `SYSTEM` rows, so a worker had no way to audit itself.
The pattern for this is the finance posting role (ADR 0076).

## Decision
1. **One login, one group.** `fbeds_ingest_ops` (a member of the NOLOGIN group `fbeds_ingest`) is the only principal that writes ingestion data. Privileges are
   stated once in `apps/api/src/database/supplier-ingest-role.ts` and rendered into statements, a catalogue verifier and privilege probes.
2. **Exactly this access.** SELECT and INSERT on `SupplierIngestRun` and the three observation tables; UPDATE on the observed value and freshness columns of
   the observation tables only (never tenant, supplier, supplier codes, stay date or creation time; no column of a run); SELECT on four
   `ConnectorDefinition` columns (`id, tenant_id, supplier_id, status`) so a connector is checked ACTIVE for its supplier; INSERT-only on `AuditEvent`.
   No DELETE anywhere. It cannot read transport metadata, credential references, contracts, rates, availability, cancellation policies, rate plans, mappings,
   suppliers, bookings, finance, users or sessions, and cannot execute any SECURITY DEFINER function. The verifier fails on any extra privilege and on any missing one.
3. **SYSTEM audit, narrowly.** Migration `202612020002_supplier_ingest_system_audit` adds `fbeds_is_supplier_ingest_role()` and a policy that admits a SYSTEM
   audit row only from that role, in the current tenant, with no user, entity type `supplier_ingest_run`, and the actions `supplier.ingest.complete|partial|failed`.
   `persist*` takes `actorUserId: null` for the worker and writes the audit row with `createMany` (no RETURNING, so INSERT-only access suffices).
4. **No fallback.** `SupplierIngestDatabase` (`SUPPLIER_INGEST_DATABASE_URL`, must differ from `DATABASE_URL`) runs ingestion as this login. When unconfigured it
   refuses with a typed 503 (`SUPPLIER_INGEST_UNAVAILABLE`) before any connection; a missing grant is the same sanitized 503, never the database message and never a
   retry as a broader principal. The first use checks the principal is a restricted role (shared `NarrowRoleDatabase`).
5. **Provisioning and certification** follow ADR 0076: owner-run, idempotent `ops:provision-supplier-ingest-role` (refuses non-local targets without
   `--allow-remote` and the exact database name, prints no secret) and `ops:verify-supplier-ingest-role`, run as the login itself, read-only, exit 0 only if the verifier
   and every probe pass. Both CLIs and the connection holder are registered in `tools/runtime-db-role-check.ts`.

## Residual risk, stated plainly
- The general `AuditEvent` insert policy admits any non-SYSTEM row in the current tenant to any role with INSERT, so this role (like the finance posting role) could write a
  forged USER-typed audit row. Constraining that is a change to the shared audit policy and is not done here. The role cannot read the audit log, and cannot write SYSTEM rows
  except the three ingestion actions above.
- The role can insert and refresh observations for any supplier of the tenant in its context; which connector and supplier a feed belongs to is decided by the calling worker
  from its own configuration, not by the database. The composite foreign keys only guarantee the connector belongs to that supplier and tenant.

## Not built (invariant 10)
- No worker, scheduler, webhook receiver, HTTP route, contract, permission or Admin screen uses the role. No environment variable is set anywhere, so nothing is enabled.
- No mapping of supplier codes to canonical ones and no promotion of observations into rates, availability or policies.
- No deployment wiring (ECS task definition, secret) for `SUPPLIER_INGEST_DATABASE_URL`.

## Rollback
Stop any process that uses the role, then `deprovisionIngestRole` (drops the login, optionally the group). The migration is forward-only; its rollback statements are in its header
(drop the policy and the function). No table, grant to another role, or data changes.

## Verification
`apps/api/test/supplier-ingest-role.e2e-spec.ts` (PostgreSQL 16, full chain replayed, no drift): the login passes the verifier and all probes; it persists rates, allotments and
policies with SYSTEM audit, replays idempotently, keeps the newer feed; it is refused for other audit actions, another tenant, evidence edits, identity edits and contracted inventory;
another tenant context sees nothing; an unconfigured connection answers 503. `supplier-ingest-role.spec.ts` covers the grant statements. The runtime-role contract spec and
`pnpm check:architecture` pass.
