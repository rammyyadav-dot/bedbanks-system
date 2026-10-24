# ADR 0089: Room Event Master and event/exhibition supplements (Phase 1 audit)

Status: Proposed. Phase 1 (repository audit and specification) only — no schema, migration or API change in this ADR. Implementation is gated on review of this ADR, per the repository's change protocol.

## Context

Hotel contracting wants to apply mandatory event-related supplements (exhibitions, trade fairs, festivals, peak citywide demand) on top of the existing contracted `DailyRate`, without rewriting that rate, and with the same deterministic pricing across search, tariff calendar, quotation and checkout. This mirrors a capability the repository already built for a different commercial case: ADR 0067's board and compulsory supplements. That precedent is the template for this work; Phase 1 is an inventory of what already exists and the concrete gaps against the new requirement, so Phase 2 extends one pricing overlay instead of building a second.

Constraints that apply throughout, per `CLAUDE.md`: tenant identity only from the session; a declared permission on every route; integer minor units; routes in `@bedbanks/contracts` before a frontend consumes them; supplier/pricing failures observable, never a silently zero-priced or demo result; idempotent mutations; encrypted/no-log credentials and PII; audit events for privileged and financial mutations; connector-specific types stay in connector packages; no placeholder presented as a production capability.

## Audit findings

### What already exists and is reusable

- **`ContractSupplement`** (`apps/api/prisma/schema.prisma:2321`). A charge layered onto `DailyRate` without mutating it: `kind` (`BOARD` | `COMPULSORY`), `basis` (`PER_ADULT`/`PER_CHILD`/`PER_PERSON`/`PER_ROOM`), `frequency` (`PER_NIGHT`/`PER_STAY`), `amountMinor` + `currency`, an optional `stayFrom`/`stayTo` window, and an optional single-plan scope (`ratePlanId`). Structurally this is most of what an event supplement needs; it lacks only an event reference, an approval/activation lifecycle, and a percentage basis.
- **`apps/api/src/supply/supplements.ts`**. Pure, transport-agnostic functions: `supplementsForPlan` selects the rows that apply to a plan (by board or compulsory scope), and `supplementNights` computes the per-night minor-unit amount and the list of applied supplements, honoring `PER_STAY` (charged once, on the first night in window) vs. `PER_NIGHT`, and skipping a rule whose window misses the stay or whose basis counts nobody.
- **`apps/api/src/supply/stay-snapshot.ts`**. `buildStaySnapshot` is the single place a `ContractedStaySnapshot` is built (its own comment, line 55-57, states the Agent search adapter and the Admin commercial views both call it). Supplements are attached at line 134 via `supplementsForPlan`. This is the existing realization of "apply the same rate-resolution service to search, tariff calendar, quotation and checkout" — event supplements should enter through this same function, not a parallel path.
- **Markup**: `packages/pricing/src/markup.ts` (`markupMinor`, round-half-up, BigInt-only) and `packages/pricing/src/cascade.ts` (`applyMarkupCascade`, ordered layers, rejects a sub-net result, rejects ambiguous same-specificity rules rather than guessing — `selectCascadeLayers`). `ContractSupplement` amounts are added before markup is computed on the combined net, per ADR 0067's own supplement section ("adds them per room after the promotion ... and before the markup"), which already matches this spec's required pricing order.
- **No mutation of `DailyRate`**: confirmed no write path touches `DailyRate` as a side effect of supplement authoring or activation.
- **Approval workflow**: `ApprovalRequest` (`schema.prisma:452`) — `requestedBy`/`decidedBy`/`executedBy`, `beforeState`/`proposedState` JSON, tenant-scoped, unique on `(tenantId, action, requestId)`. ADR 0067 F-01 already uses this pattern (plus a dedicated `ContractVersion` immutable-snapshot table) for contract maker-checker; the same pattern is the template for event/supplement approval and segregation of duties.
- **Audit**: `AuditEvent` (`schema.prisma:1670`) — tenant-scoped, `entityType`/`entityId`/`payload`, immutable by convention.
- **RBAC**: permission-key-and-guard pattern (`RequirePermission`, `apps/api/src/agent/rbac.guard.ts`; tenant scoping via `TenantContextGuard`/`ActiveTenant`), used uniformly (e.g. `apps/api/src/admin-operations/operations.controller.ts:56`). Roles and permissions are DB-driven (`Role`, `Permission`, `RolePermission`), so new permission keys for this module (e.g. `event-supplement.approve`) need no schema change.

### Gaps against the spec

1. **No event catalogue.** `SupplementKind` is `BOARD | COMPULSORY` only. There is no `RoomEvent` master table, no event lifecycle (Draft/Pending Approval/Approved/Cancelled/Archived), and no distinction between event dates and the (possibly narrower, possibly pre/post-event) supplement-application window — the spec requires these to be separate fields.
2. **No versioned supplement history.** `ContractSupplement` rows are mutable, with no equivalent of `ContractVersion`'s immutable, fingerprinted snapshot. The spec's `EventSupplementVersion` has no analog yet for supplements (only for whole contracts).
3. **No stacking/priority/conflict policy for supplements.** `supplementNights` sums every matching rule unconditionally; nothing detects or rejects overlapping event rules the way `selectCascadeLayers` rejects ambiguous markup rules. Today this is safe because board/compulsory rules are assumed non-overlapping by construction; event supplements explicitly can overlap (two events, hotel-wide vs. room-specific) and need a documented precedence or fail-closed rule.
4. **No percentage-based supplement.** `SupplementBasis` only expresses fixed per-adult/child/person/room amounts. The spec requires a contracted-percentage basis with an explicit, non-silent calculation base.
5. **No status/approval gate on the supplement row itself.** `ContractSupplement` has no Draft/Pending/Approved/Active/Suspended/Expired status and is not wired to `ApprovalRequest`; it takes effect as soon as it is written (inside an editable contract). Segregation of duties (creator ≠ sole approver) is not enforced for this entity.
6. **No distinct hotel-wide vs. room-specific precedence model** beyond the existing board/plan scoping, and no explicit cross-entity compatibility validation (event ↔ hotel ↔ supplier ↔ contract ↔ rate plan) beyond what `ContractSupplement`'s own FKs give it.
7. **No admin API surface.** None of the `/admin/room-events` or `/admin/event-supplements` routes exist.
8. **No structured rate-impact breakdown for supplements.** The markup cascade has `LayerTraceStep`; there is no equivalent per-supplement trace (contracted base, supplement total, adjusted net, selling rate) for a Rate Impact Preview screen.

## Decision (Phase 1 scope)

This ADR records the audit only. The recommended Phase 2 direction, to be reviewed before implementation:

- Extend the existing overlay rather than introduce a parallel tariff table: either add `EVENT` to `SupplementKind` with the new fields guarded by kind-specific validation (mirroring how `BOARD` requires `boardBasisId` and `COMPULSORY` forbids it today), or introduce a sibling `EventSupplement` model with the same base shape (`basis`, `frequency`, `amountMinor`, `currency`, `stayFrom`/`stayTo`) plus `roomEventId`, `status`, and conflict-handling fields (`priority`, `stackable`). The latter keeps `ContractSupplement`'s existing invariants untouched and is the lower-risk path given `ContractSupplement` is already load-bearing for ADR 0067.
- Add a `RoomEvent` master table (event catalogue) and an `EventSupplementVersion` modeled directly on `ContractVersion` (immutable, fingerprinted, trigger-enforced no UPDATE/DELETE).
- Extend `supplementsForPlan`/`supplementNights`, or add a sibling function called from the same point in `buildStaySnapshot`, so search/calendar/checkout stay consistent by construction; add an explicit conflict-resolution step for overlapping event rules modeled on `selectCascadeLayers`'s "most-specific-wins, ambiguous throws" rule rather than silently summing.
- Gate activation through `ApprovalRequest` (or a maker-checker service following the Contract F-01 pattern), write `AuditEvent` rows on create/approve/activate/suspend/amend, and add the new permission keys for CONTRACTING/OPERATIONS/FINANCE/SUPPLIER_ADMIN roles named in the spec.
- Each of these needs its own reviewed forward migration with rollback notes and a tenant-index review, per the repository's change protocol — not bundled into one migration.

## Not built (explicitly out of Phase 1 scope)

Schema changes, migrations, API routes, admin screens, and pricing-engine integration are all Phase 2+ and require their own ADR update or amendment once the approach above is reviewed and a gate decision is made.
