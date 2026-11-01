# ADR 0081: Supplier rate plan mapping and observation resolution

Status: Accepted (mapping governance and a read-only resolver; promotion into sellable inventory is deliberately not built)
Date: 2026-10-21

## Context
Ingested rates, allotments and cancellation policies (ADR 0077-0080) are observations keyed by supplier codes. Hotel and room codes already resolve through governed mappings
(ADR 0004), but there was no governed link from a supplier *rate plan* code to a canonical contracted `RatePlan`, and nothing that joined an observation to those mappings.
Without both, either nothing can be sold from a feed, or someone is tempted to match plans by name or price.

## Decision
1. **A third mapping level.** `SupplierRatePlanMapping` links one supplier rate plan code, under one supplier room mapping, to one canonical `RatePlan`. Same lifecycle
   as hotel and room mappings: created PENDING by a person, then approved, rejected or reopened by a person, each step with an audit event (ids and codes only).
   Permissions are the existing `supply.mappings.read` and `supply.mappings.manage`. There is no automatic or suggested approval.
2. **What a mapping may link.** The plan must be of the mapped room type, of a contract with the mapped supplier, in the same tenant, and not derived (a derived plan has no nightly
   rates of its own, ADR 0058). A supplier code maps to one plan and a plan to one code (unique per tenant). Enforced in the service and again by a database trigger, so a bypass fails too.
   The trigger also makes identity columns immutable and refuses MAPPED unless the room mapping is MAPPED.
3. **Dependency order is enforced downward as well.** A room mapping cannot leave MAPPED while an approved rate plan mapping depends on it (service message plus trigger). Approve order is
   hotel, room, rate plan; unwinding is the reverse.
4. **Routes** are under `/supply/mappings/hotels/:mappingId/rooms/:roomMappingId`: `rate-plan-options`, `rate-plans`, and `rate-plans/:id/approve|reject|reopen`, declared in `@bedbanks/contracts` first.
5. **Resolver** (`apps/api/src/mapping/observation-resolution.ts`, pure, no I/O). A rate, allotment or cancellation observation resolves only through MAPPED hotel, room and rate plan mappings,
   chained. Otherwise it returns a stable reason: `HOTEL_UNMAPPED | HOTEL_NOT_APPROVED | ROOM_UNMAPPED | ROOM_NOT_APPROVED | RATE_PLAN_UNMAPPED | RATE_PLAN_NOT_APPROVED`, then, for rates,
   `CURRENCY_MISMATCH` (observation currency differs from the plan's) and `TAX_BASIS_UNSTATED` (ADR 0060 #5: unstated is a block, not "included"), and finally `STALE` (`now >= fresh_until`).
   Mapping gaps are reported before staleness. A room-wide allotment (no plan code) resolves to the room with `ratePlanId: null`; a cancellation policy without a room code resolves to every approved plan
   with that code. Nothing is guessed, defaulted or partially resolved.
6. **Review feed.** `summarizeResolutions` counts outcomes and lists the distinct supplier codes behind *mapping* gaps, most frequent first, capped at 200. Currency, tax and staleness outcomes are counted
   but are not mapping work, so they never enter the review list. `pending`/`rejected` are reported differently from `unmapped`.
7. **Index loader** (`supply/mapping-index.loader.ts`) loads one supplier's mappings of every status inside a caller-supplied tenant transaction; every query names the tenant.
8. **Authority.** Mapping rows are a privileged write path (`PRIVILEGED_WRITE_MODELS`, like hotel and room mappings): on a strict runtime role a write answers the typed 403, not a 5xx. The strict role gets
   SELECT through the runtime role contract (re-provisioning applies it); the migration grants nothing.

## Migration `202612030001_supplier_rate_plan_mapping`
New table with composite tenant keys, RLS enabled and forced, tenant-leading indexes, CHECKs, and two triggers. It also adds `UNIQUE (tenant_id, id)` on `SupplierRoomMapping` and `RatePlan` so the
composite keys can exist; both are implied by the existing primary key, so they cannot fail on existing data. Rollback statements are in the migration header; mappings are decisions, so export them first.

## Not built (invariant 10: do not present as capability)
- **No promotion.** Nothing writes `DailyRate`, `DailyAvailability` or `CancellationPolicy` from observations. Observations stay unsellable. Promotion needs decisions this ADR does not make: how a
  supplier feed relates to an ACTIVE contract and its version/approval (ADR 0067), whether feed prices overwrite contracted rates or only supplement them, the NET versus SELL basis and tax semantics
  (ADR 0029, 0034), how room-wide allotments fan out and interact with pools (ADR 0030, 0036), who may write those tables (a new narrow role, since the runtime role must not), and how a withdrawn night is
  handled. Each is a product/finance decision for the owner.
- No process calls the resolver. The ingestion role cannot read the mapping tables and the API runtime role cannot read observations, by design; the promotion role will need both and is part of that slice.
- No Admin screen for rate plan mappings or for the review feed, and no mapping suggestions for rate plans.

## Rollback
Remove the routes, `RatePlanMappingService`, the resolver and loader. The table and triggers are rolled back by the migration header statements. No other data changes.

## Verification
`apps/api/src/mapping/observation-resolution.spec.ts` (7 unit tests) and `test/supplier-rate-plan-mapping.e2e-spec.ts` (PostgreSQL 16, full chain, no drift): creation rules and permissions, conflicts, audited
lifecycle, approval order, downward dependency guard (service and trigger), identity immutability, trigger refusal of wrong room type, supplier and tenant, and the loader plus resolver end to end across tenants and suppliers.
The full API unit suite, `admin-golden-path`, `contract-approval`, the runtime-role contract spec and `pnpm check:architecture` pass.
