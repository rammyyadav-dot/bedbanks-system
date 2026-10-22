# ADR 0084: Supplier promotion writer and its database role

Status: Accepted (writer, role and run evidence built and tested; nothing invokes the writer yet)
Date: 2026-10-21

## Context
ADR 0077-0081 normalize, store and resolve supplier feeds; ADR 0082 and 0083 record the owner's decisions on how a feed may touch contracted data. The step that applies them, writing
`DailyRate`, `DailyAvailability` and `InventoryPoolDay`, did not exist, and no principal was allowed to do it from a feed (the strict API role must not, ADR 0032).

## Decision
1. **A narrow role** `fbeds_promote_ops` (group `fbeds_promote`), stated once in `database/supplier-promotion-role.ts` and rendered into grants, a catalogue verifier and 76 privilege probes, with owner-run
   provision and read-only verify CLIs (as ADR 0076 and 0079). It reads the two observation tables, named columns of the mapping tables, `RatePlan`, `InventoryPool`, `Hotel` and the latest-run columns of
   `SupplierIngestRun`; reads and appends `DailyRate`, `DailyAvailability`, `InventoryPoolDay` and its own run table; updates only value and provenance columns (`amount_minor`, `amount_basis`, `currency`, source
   fields on rates; `allotment`, `stop_sell`, `release_days`, `inventory_mode` and freshness on availability; `capacity` and freshness on pool nights); appends audit events. It cannot write `sold`, `held`,
   minimum stay, closed to arrival or departure, any identity column, a contract, plan, pool, mapping or cancellation policy, and cannot delete anything.
2. **Run evidence.** Migration `202612040001_supplier_promotion` adds `SupplierPromotionRun` (append-only; status `APPLIED | HELD | NOTHING_TO_PROMOTE`; counts; a capped reason-code summary; forced RLS; composite
   tenant key; a CHECK that a HELD or NOTHING run wrote zero rows) and a SYSTEM audit policy limited to this role, this tenant, entity `supplier_promotion_run` and three actions.
3. **The writer** `SupplierPromotionService.promote` runs one transaction on that role per call, serialized per tenant and supplier by an advisory lock, idempotent per key (a replay writes nothing), with the run and
   audit event in the same transaction. It applies the owner's decisions exactly:
   - Works from the latest applied delivery of each feed kind for one connector. Observations are latest-state, so only rows written by that run say what the delivery mentioned; a night an earlier delivery
     mentioned and this one did not is therefore visible as omitted instead of being promoted again.
   - Rates: resolve through approved mappings (ADR 0081), then `checkRatePromotable` (NET declared, tax stated inclusive, plan flagged, enabled currency equal to the plan's, positive), then write `amountBasis NET` at the
     plan's own occupancy. A night before the hotel-local today is skipped.
   - Guard: the stored prices of the touched plans over the nights the feed covers are compared with the batch; a night moving more than 30%, or more than 20% of stored nights missing, holds the whole batch: nothing is
     written, a HELD run and audit event say why.
   - Stock: plan-level counts go through `planStockCount` (declared semantics); a plan-level statement on a pooled plan is blocked; room-wide statements route to the plan's one active pool (`NEEDS_POOL` otherwise) and set
     pool capacity with `sold + held` respected, while the pooled plans' own rows carry mode and stop-sell; two room-wide statements disagreeing about one pool night block both (`POOL_NIGHT_CONFLICT`).
   - A person's close is never reopened (`SKIPPED_MANUAL_CLOSE`, the night, not the batch).
   - Omitted nights: for plans the batch made a statement about, nights a feed previously promoted, still open and inside the declared coverage window are closed.
   - New availability rows start with the platform defaults for restrictions and `sold`/`held` at zero; existing rows keep theirs. Every written row carries source `SUPPLIER_FEED` and the observation's `fresh_until`.
   - A run that wrote nothing is recorded `NOTHING_TO_PROMOTE`.
4. **Connection.** `SupplierPromotionDatabase` (`SUPPLIER_PROMOTION_DATABASE_URL`, must differ from `DATABASE_URL`) refuses with a typed 503 before connecting when unconfigured; a missing grant is the same sanitized 503, never
   a retry as a broader principal. Both CLIs and the connection holder are registered in `tools/runtime-db-role-check.ts`. The source-scan test for the single writer (ADR 0082) lists this service as its one exemption.

## Not built (invariant 10: do not present as capability)
- **Nothing invokes the writer.** No worker, schedule, route, permission or Admin screen; no environment flag exists. It runs only when code calls `promote`, on a connection that holds the role. Nothing is deployed or provisioned.
- **A held batch has no review workflow.** HELD is evidence only; there is no screen, no approve-and-apply action, and no automatic retry. Applying a held batch needs a person and a new, reviewed mechanism.
- **Sellability is verified for search and recheck only.** `supplier-promotion-sellability.e2e-spec.ts` shows promoted rows are what Agent search and recheck sell. Holds, prebook and booking were not exercised
  (booking is disabled platform-wide, ADR 0007), and the test uses a synthetic supplier and an ACTIVE contract linked to an approved hotel mapping.
- Cancellation policies are not promoted; neither are minimum stay, maximum stay, closed to arrival or departure (undecided, ADR 0083).
- Manual allotment-count edits on a feed-managed plan are still not refused (ADR 0083).
- Rates for nights a feed drops are not withdrawn (only availability is closed); they count toward the 20% guard and otherwise stay until a person or a later feed changes them.
- The whole batch is loaded and written in one transaction with per-row updates: correct, but untested at the volume of a large channel manager; chunking and a size limit are future work. "Today" is the hotel-local date
  from the hotel's time zone.
- No mapping suggestions, no operator view of promotion runs, and no Admin copy telling mapping reviewers that approval hands a plan to a feed.

## Rollback
Stop whatever calls the writer, then `deprovisionPromoteRole`. The migration is forward-only; its rollback statements are in its header (drop the policy, function and table; rates and availability already written stay
and must be corrected by people). No other table, grant or permission changes.

## Verification
`test/supplier-promotion.e2e-spec.ts` (PostgreSQL 16, full chain replayed, no drift, narrow role): verifier and all probes pass; rates, plan stock and pool capacity promoted with provenance and freshness; blocks reported;
run evidence and SYSTEM audit; idempotent replay; REMAINING respects sold and held; manual close not reopened; omitted night closed only for feed-promoted nights; 30% move holds the batch with nothing written; undeclared
profile promotes nothing; the role is refused outside its lane and isolated by tenant. `supplier-promotion-role.spec.ts` covers the grants.

**Sellability** (`test/supplier-promotion-sellability.e2e-spec.ts`, 8 tests, real `ContractedInventoryAdapter`, no mocks): nothing is sold before promotion; a promoted NET rate with stock is still not sold without an ACTIVE markup rule
(ADR 0018); with one, the plan is sold at net plus integer markup (82,500 net, 8,250 markup, 90,750 sell for two nights) and recheck confirms the same price; a REMAINING count of 1 shows `limited`, 0 hides the plan and a larger count
restores it; room-wide stock in a pool makes two plans share one unit (both `limited`, both hidden once it is sold); a plan failing the tax-flag rule is never promoted and never sold; a held batch leaves the previous price selling;
expired promoted stock hides the offer (a feed that stops fails closed); a night the complete feed drops is closed, removing every stay through it while a stay avoiding it still sells. The full API unit suite and `pnpm check:architecture` pass.
