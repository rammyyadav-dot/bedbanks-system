# ADR 0098: Agency commission payout engine

Status: **Built. Off until `COMMISSION_PAYOUTS_ENABLED=true`.**

## Finding

Hotel contracts already carry `commissionBp` for `COMMISSIONABLE` rate plans (ADR 0067), and supplier settlements (ADR 0077) pay what fBeds owes a *supplier*. Nothing in the platform pays a
commission *to an agency* for the volume it books, and nothing resolves a volume-based rate without a human picking a number by hand each time — which is exactly the kind of proportional,
money-moving calculation CLAUDE.md's invariants (integer minor units, server-authoritative tenant and amount, immutable audit events, idempotent mutation) exist to keep out of ad hoc code.

## Decision

1. **A pure tier table and calculator** (`apps/api/src/finance-commission/commission-tier.ts`): `resolveCommissionTier(grossBookedMinor, rules?)` picks the highest tier whose threshold the
   volume clears (BRONZE/SILVER/GOLD/ENTERPRISE, ascending basis-point rates), and `commissionAmountMinor(grossBookedMinor, commissionBp)` is `floor(grossBookedMinor * commissionBp / 10000)`
   in bigint — no floating point anywhere in the path. `calculateCommission` composes the two. All three are unit-tested without a database. The default table
   (`DEFAULT_COMMISSION_TIERS`) is an engineering default, not an owner decision; a deployment that wants different thresholds passes its own `rules` array, same shape, same resolver.
2. **The tier and rate are never client-supplied.** `CommissionPayoutService.propose` takes only `agencyId`, a closed `periodStart`/`periodEnd` and the agency's `grossBookedMinor` for that
   period (itself an input finance verifies before proposing, not something this service derives from bookings yet — see Not done); the server resolves `tier`, `commissionBp` and `amountMinor`
   and stores all three, so a decided payout's numbers can always be recomputed and checked.
3. **Maker-checker, mirroring `BookingCreditNote` (ADR 0095 part B) and `SupplierSettlement` (ADR 0077).** `AgencyCommissionPayout` is `PROPOSED` by one person; a different person `approve`s or
   `reject`s. Approval locks the agency's wallet in the payout's currency and posts exactly one `CREDIT` ledger entry, in the same transaction, keyed
   `agency:<agencyId>:commission-payout:<payoutId>` — idempotent, and the row links the entry (`@unique`) so it can never be posted twice. `(tenantId, requestId)` makes the proposal itself
   idempotent on retry. `(agencyId, periodStart, periodEnd)` is unique, so a period can be paid at most once. Every propose/approve/reject writes an immutable `AuditEvent`. A database trigger
   (`fbeds_commission_payout_guard`) refuses any update to a decided row and any delete, exactly like the credit note guard.
4. **Runs on the API connection, not the runtime role**, same reasoning as the credit note and settlement services: posting the `CREDIT` needs ledger access the booking module's narrow runtime
   role does not have (ADR 0032). `AgencyCommissionPayout` is classified finance-gated in `runtime-role-contract.ts`; row-level security is enabled and forced.
5. **Feature-gated and permissioned like its siblings.** `COMMISSION_PAYOUTS_ENABLED` must be `true` for writes; reads always work. `finance.commission.propose` and `finance.commission.approve`
   are new department permissions (`@bedbanks/contracts`), granted to no role by the migration — an operator assigns them deliberately.

## Not done (explicit gap, not claimed)

- **Gross booked volume is a finance-supplied input, not yet derived from `Booking`/`LedgerEntry` aggregation.** A follow-up should compute it from confirmed, charged bookings in the period so a
  proposer cannot misstate it; until then, finance verifies the number before proposing, the same trust boundary ADR 0077's settlement amounts already rely on.
- **No scheduled job proposes payouts automatically.** Each period is proposed by a person today; a reconciliation worker that proposes once a period closes is a reasonable next step and does
  not change the schema or the approval path.
- **The tier table is a single global default**, not yet overridable per tenant from an admin screen; `rules` exists in the calculator for exactly that extension.
