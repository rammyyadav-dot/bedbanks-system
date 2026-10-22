# ADR 0078: Persistence of normalized supplier ingestion

Status: Accepted (storage and write path only; nothing schedules, receives or reads ingestion yet)
Date: 2026-10-21

## Context
ADR 0077 produces canonical, validated rates, allotments and cancellation policies with a `COMPLETE | PARTIAL | FAILED`
status, but keeps nothing. Persisting them must not make supplier data sellable by accident (CLAUDE.md invariants 5, 9, 10;
ADR 0060 #5, ADR 0064).

## Decision
Migration `202612020003_supplier_ingest_observations` adds four tenant-owned tables and two enums.

1. **Observations, not inventory.** `SupplierRateObservation`, `SupplierAllotmentObservation` and
   `SupplierCancellationObservation` are keyed by *supplier* codes (hotel, room, rate plan, night). They are not
   `DailyRate`, `DailyAvailability` or `CancellationPolicy`, and no search, recheck or booking path reads them. Resolving supplier
   codes to canonical hotels and rooms stays in mapping governance (ADR 0004).
2. **Latest state per natural key.** One row per supplier night (rates, allotments) or rate plan (policies), refreshed by upsert.
   A conflict update fires only when the stored `received_at` is not newer than the incoming run's, so a delayed older feed cannot
   overwrite fresher data; a trigger is the backstop. History is the run record plus the audit event, not row versions.
3. **Evidence per run.** `SupplierIngestRun` is append-only (trigger): status, counts, a reject summary of `code:field` counts
   (at most 100 buckets, no row content), the idempotency key and the SHA-256 of the normalized result. A CHECK allows
   `applied = true` only for a `COMPLETE` run with a future `fresh_until` and at least one accepted row. PARTIAL and FAILED runs are
   recorded and apply nothing.
4. **Idempotency.** Unique `(tenant_id, connector_id, idempotency_key)`. The same key and the same result hash replays the stored
   outcome and writes nothing; the same key with different content is refused (`IDEMPOTENCY_CONFLICT`). A transaction-scoped advisory
   lock serializes concurrent deliveries of one key.
5. **Freshness.** Every observation carries a required `fresh_until > received_at` (ADR 0030 #7); there is no unexpiring supplier
   row. Rows are never deleted by the application. Retention and offboarding use the owner-governed flag `fbeds.ingest_erasure`,
   which the application never sets (same model as the ledger erasure flag).
6. **Integrity.** Composite `(tenant_id, …)` foreign keys to `Supplier`, `ConnectorDefinition` (so the connector must belong to the
   supplier) and the run. Forced RLS on all four tables. CHECKs for BIGINT minor units and positive net (ADR 0034), `CHAR(3)` currency,
   allotment count required exactly when the mode is `ALLOTMENT` (a missing count cannot be stored as zero, ADR 0030 #4), stay and
   release ranges, and code formats. Every index starts with `tenant_id`.
7. **Write path.** `apps/api/src/supplier-ingest/ingest-persistence.ts` exposes `persistRates`, `persistAllotments` and
   `persistCancellationPolicies`. They run inside a caller-owned `withTenant` transaction, so run, observations and audit event
   commit together. Tenant, supplier and connector come from the caller's authenticated context, never the feed. The connector must be
   `ACTIVE`. Bulk writes are chunked `INSERT … SELECT FROM unnest(…) ON CONFLICT`, each statement naming the tenant. The audit action
   is `supplier.ingest.<status>`.

## Not built (invariant 10: do not present as capability)
- **Writer role: see ADR 0079.** The tables are privileged paths and the API runtime role has no grant. ADR 0079 adds the dedicated ingestion login, its
  certification, and the narrow SYSTEM audit policy, so a worker can audit itself (`actorUserId: null`). It is provisioned by the owner and nothing uses it yet.
- No HTTP route, `@bedbanks/contracts` entry, permission, scheduler, webhook receiver, or Admin screen.
- No mapping of supplier codes to canonical hotels, rooms or plans, and no promotion into `DailyRate`/`DailyAvailability`.
- No withdrawal of nights a later feed omits: omission is handled by `fresh_until` expiry only.
- Cancellation windows are stored as canonical JSONB (ordered, validated by the ingest core); percent and nights penalties are
  not priced here.

## Rollback
Forward migration, reviewed first, only while no ingestion is running; it discards ingestion evidence. The statements are in the
migration header. No other table, grant or permission changes.

## Verification
`apps/api/test/supplier-ingest-persistence.e2e-spec.ts` (PostgreSQL 16, full migration chain replayed, no drift): idempotent replay and
conflict, partial-run evidence, newer-wins, allotment/policy persistence, disabled and foreign-tenant connectors refused, database
guards (append-only, positive money, composite tenant keys), and RLS as a non-owner role. Unit tests cover hashing and reject summaries.
The runtime-role contract spec and the regenerated matrix in `docs/strict-runtime-db-role.md` pass. `pnpm check:architecture` passes.

## Amendment 2026-10-21: migration ID
The migration was first committed as `202612020001_supplier_ingest_observations`, which collided with `202612020001_booking_posting_revenue_columns` (ADR 0076) and failed the ledger guard. It is now `202612020003_supplier_ingest_observations`; the SQL is unchanged. `202612020002` does not depend on its tables, so the order change is safe on a fresh database. **Before deploying:** any database that already applied the old name holds a history row under it. Prisma would treat `202612020003` as new and try to create the tables again. On such a database, rename that row in `_prisma_migrations` (same checksum) in the owner session before running `migrate deploy`. Neither staging nor production applies migrations automatically, and the old name was on `main` for hours, so this is expected to affect only local or ad-hoc databases.
