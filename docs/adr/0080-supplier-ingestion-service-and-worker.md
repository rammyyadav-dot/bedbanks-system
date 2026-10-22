# ADR 0080: Supplier ingestion service and worker

Status: Accepted (orchestration only; no real source, profile, fetcher or job is registered, and nothing is enabled)
Date: 2026-10-21

## Context
ADR 0077 normalizes documents, ADR 0078 stores the result, ADR 0079 gives the write path its own database role. Nothing connected them: no code took a document, ran it through the
normalizer and wrote it as that role, and nothing triggered it.

## Decision
`apps/api/src/supplier-ingest` adds the orchestration and keeps provider specifics out of it.

1. **Profile.** `IngestProfile` is configuration: document format (`xml` | `json`), an extraction spec per feed kind, required `freshnessMs` (one minute to seven days; no unexpiring
   supplier data), optional horizon, reject threshold and cancellation cut-off settings. `IngestProfileRegistry` rejects duplicate or malformed keys and empty specs. The registry ships empty.
2. **Service.** `SupplierIngestService.ingest(job, delivery)`: profile lookup, extract, normalize, persist as the ingestion role, `actorUserId: null` (SYSTEM audit, ADR 0079).
   - An unknown profile or a feed kind the profile has no spec for is refused (`IngestJobRefused`) before any run exists.
   - A document that cannot be read (wrong shape, DOCTYPE, bad JSON, oversize) is recorded as a FAILED run: evidence that a delivery arrived and was refused. It writes no observation.
   - Only COMPLETE applies observations; PARTIAL and FAILED are evidence only (ADR 0078).
   - The idempotency key is `sha256(profile|kind|deliveryId)`. A retried delivery replays; the same delivery id with different content is refused (`IDEMPOTENCY_CONFLICT`).
   - "Today" for the stay-date window is the delivery's receipt date, so a late replay is judged against when it arrived. Payloads are never logged; only counts and codes.
3. **Ports.** `FeedJobSource.dueJobs()` and `FeedFetcher.fetch(job)` are interfaces. Tenant, supplier and connector come from the job source (server-side configuration), never from a document.
   Fetching is transport work (endpoint policy, secrets, retries: ADR 0060) and belongs to the source's own connector, not to this service. The defaults are no jobs and a fetcher that throws.
4. **Worker.** `SupplierIngestWorker` runs only with `SUPPLIER_INGEST_ENABLED=true` and `SUPPLIER_INGEST_WORKER_ENABLED=true`. Enabled, the API refuses to start unless
   `SUPPLIER_INGEST_DATABASE_URL` is set and differs from `DATABASE_URL`, at least one profile is registered, and a real job source and fetcher are registered; the interval must be an
   integer of at least 5000 ms (default 60000). A pass never overlaps itself, a failing job is logged by code and does not stop the others, and it is harmless across processes
   (unique run per key, advisory lock).
5. **Module.** `SupplierIngestModule` is imported by `AppModule`. With no flags it does nothing.

## Not built (invariant 10: do not present as capability)
- **No real provider.** No profile, job source or fetcher exists, so the worker cannot be enabled today (it refuses to start). Tests use synthetic, unregistered profiles.
- No fetching: no HTTP or SOAP pull from any supplier, and no webhook or push receiver (a receiver needs authentication, signature verification and its own ADR).
- No HTTP route, `@bedbanks/contracts` entry, permission, or Admin screen; no operator view of runs.
- No mapping of supplier codes to canonical hotels, rooms and plans, and no promotion of observations into rates, availability or cancellation policies. Observations remain unsellable.
- No deployment wiring (task definition, secret) for the flags or `SUPPLIER_INGEST_DATABASE_URL`.
- Nights a later feed omits are not withdrawn; they expire by `fresh_until`.

## Rollback
Remove the `SupplierIngestModule` import from `AppModule` and the `supplier-ingest` directory's service, worker and module files (the persistence and database files belong to ADR 0078/0079). No
schema, grant or data change. Unset the flags to stop the worker without a deploy of code.

## Verification
`test/supplier-ingest-service.e2e-spec.ts` (PostgreSQL 16, narrow role): JSON rates applied, replay, conflicting republish, PARTIAL evidence, FAILED evidence for unreadable XML and JSON,
days-before-arrival cancellation windows with the profile cut-off, refusals before any run, and the worker running jobs through the service, surviving a failing job and not overlapping.
`supplier-ingest.worker.spec.ts` covers startup refusals and the registry. The full API unit suite, `health.e2e` (application boots with the module) and `pnpm check:architecture` pass.
