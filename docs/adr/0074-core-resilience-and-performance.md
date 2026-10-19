# ADR 0074: Core resilience and performance (read replica, search hot path, streaming)

## Status
Accepted. Built and measured on PostgreSQL 16 as a restricted, non-BYPASSRLS login with forced row-level security. **Not run against Neon.**

## Context
Three goals were set: Neon read replicas for analytical queries and financial reporting; faster execution plans for the high-frequency hotel search filters; stream-based processing for statement imports and bulk hotel exports. The request named Drizzle ORM.

The API does not use Drizzle. It is NestJS on Prisma with transaction-local tenant context (`SET LOCAL` through `withTenant`), forced RLS, an audited list of connection pools (ADR 0067), restricted-role identity checks, and a migration-drift tool built on Prisma. A second ORM would sit beside all of that without sharing any of it, so **this ADR does not introduce Drizzle**. Each goal is met with Prisma, SQL and Node streams. ADR 0067 also stays in force: no `@neondatabase/serverless`.

## Decision

### 1. Read replica (reports only, fail closed)
`BookingOpsReadReplica` (`database/read-replica.database.ts`) is a `NarrowRoleDatabase` over `BOOKING_OPS_READ_REPLICA_URL`: the booking login's credential against a Neon read-only compute of the same branch. Grants, RLS and the restricted-role identity check are therefore the primary's. Every transaction is `READ ONLY` with a statement timeout (15 s).
- Not configured, or equal to a primary URL: callers use the primary booking login. That is a deployment choice.
- Configured but unusable: `503 READ_REPLICA_UNAVAILABLE`. It never falls back to the primary (a replica outage must not push reporting load back onto it) and never returns an empty result (invariant 5).
- First consumer: the hotel report. Reads that precede a decision or must show the caller's own write (booking, hold, wallet, ledger, reconciliation workflow) stay on the primary, because replicas can trail. Further reports are added one at a time against that rule.
- The runbook is `docs/runbooks/read-replica.md`. The replica adds one pool per task to the connection budget in ADR 0067.

### 2. Availability search hot path
Measured with one tenant of 60,000 hotels (3 room types and 6 rate plans each), as the restricted login:

| Step | Before | After |
| --- | --- | --- |
| Hotel lookup for a resolved city | 28 ms, sequential scan of the tenant | 0.4 ms, index scan |
| Rate plan candidates for that city | sequential scan of 60,000 contracts | nested loop from the mapped hotels (execution 39 to 23 ms) |
| Directory ordered by `(name, id)` | sort of the whole tenant per page | index-ordered scan |

Migration `202611280001_hotel_search_hot_path`: generated column `Hotel.city_key = lower(city)`, partial index `(tenant_id, city_key, id) WHERE content_status = 'COMPLETE'`, `Contract(supplier_hotel_mapping_id)`, `Hotel(tenant_id, name, id)`. The adapter now looks a resolved city up with `city_key = lower($1)` (`agent/hotel-candidates.ts`); results were compared with the previous Prisma filter and are identical.

**Why a generated column and not an expression index.** Under forced RLS, PostgreSQL will not use an index for a non-leakproof qual. `lower()`, `LIKE` and `ILIKE` are not leakproof; `=` and `<`/`>` on text are. An index on `lower(city)` is used for a superuser and ignored for the runtime login (verified). The generated column makes the indexed comparison a plain `=`.

### 3. Streaming
- **Hotel export** (`GET hotels/export`): keyset batches of 50 ordered by `(name, id)`, each a short tenant transaction, written to the response through `stream.pipeline` so reads happen only as the client drains. The audit event is written before the first byte; a second event, `hotel.export_finished`, records the row count and whether the stream completed, failed or was abandoned. A failed stream ends the connection with an error, never a clean-looking file. `X-Export-Rows` and `X-Export-Truncated` come from an up-front count. Computed filters (readiness, contract state, issue, expiry) need a whole-candidate assessment first and keep the bounded buffered path.
- **Statement import** (`POST statements/stream`, `application/x-ndjson`, contract in `@bedbanks/contracts`): header line, then one line per statement line. `statement-stream.ts` splits and validates as bytes arrive, enforces total size (4 MB), line size (4 KB) and line count while reading, stops at the first invalid line and names it. It shares the validators, idempotency (`requestId`) and content hash with the JSON import, so a statement cannot be imported twice by switching channel. Lines are inserted in batches of 1,000. Statement tables are immutable, so the hash must exist before the insert: the validated lines are held in memory, not the upload text.

## Consequences and limits
- **Export throughput is bounded by CPU, not by the stream.** Each row needs the commercial assessment, measured at about 14 ms per hotel (same as the existing paged list). `HOTEL_EXPORT_STREAM_MAX_ROWS` is 25,000 (about six minutes), and the batch work is synchronous on the API event loop, hence small batches with a yield between them. Larger exports need a cheaper assessment first.
- **The statement line limit stays 5,000.** The reconciliation run loads every line in one transaction and updates findings one by one. It has not been load-tested above 5,000, so the stream path does not raise the limit.
- **The trigram indexes from ADR 0072 are not used by the runtime login.** They use `lower(...) LIKE` and `<%`, which are not leakproof; the query plan under RLS is a sequential scan (27 ms for a selective term at 70,000 hotels, versus 1.4 ms as a superuser). The destination typeahead and the free-text `contains` destination filter still scan the tenant. Two options were considered and neither is built:
  - A `SECURITY DEFINER` function pinned to `fbeds_current_tenant_id()` does reach the index (substring branch alone: 7.8 ms as owner against 43.8 ms for the restricted login). It was prototyped and rejected for now: the typeahead's fuzzy `<%` branch dominates its cost and the function showed no gain on the full query (about 190 ms against 165 ms on synthetic data), while adding a security-definer surface, a role-contract grant and a dependency on the owner bypassing RLS.
  - A prefix search as a range on a key column (leakproof comparisons) would be indexable, but it changes the typeahead from substring to prefix matching, which is a product decision.
- `Hotel.city_key` is a stored generated column: its creation rewrites `Hotel` under an exclusive lock. Run the migration in a quiet window.
- Prisma cannot declare the generated column or the partial index; `scripts/check-migration-drift.mjs` tolerates those two by name.

## Verification
Unit tests for the city query, replica configuration and routing, the CSV pieces, the export stream (batches, audit order, abort, failure, truncation) and the NDJSON parser (chunking, UTF-8, limits, parity with the JSON import hash). Against PostgreSQL 16: replica transaction refuses writes, enforces the timeout and respects RLS; the streamed export returned 667 of 667 rows in exactly the database's `ORDER BY name, id`, and an abandoned export recorded `completed: false`; a 5,000-line streamed import persisted in 585 ms and replayed, rejected duplicate content, and left nothing behind on an invalid line. `pnpm check:architecture` passes.

Not verified: Neon (replication delay, autosuspend, `max_connections`), pgvector, behaviour with the full e2e suite (needs the strict role provisioning), the reconciliation run above 5,000 lines.

## Rollback
Remove `BOOKING_OPS_READ_REPLICA_URL`. Redeploy the previous API, then drop the four indexes and the `city_key` column (statements in the migration header). Revert the controller change to return to the buffered export.
