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
2. **Nothing about the amount is client-supplied — including the volume.** `CommissionPayoutService.propose` takes only `agencyId`, a closed `periodStart`/`periodEnd` and a `currency`.
   `grossBookedMinor` is derived inside the same tenant transaction by `commission-volume.ts`: net posted revenue (sales less refunds) on `BookingFinancePosting` rows the Finance consumer has
   POSTED, summed across the agency's wallets in that currency, dated by posting date and half-open on `periodEnd` — the same source and convention `BookingRevenueService` (ADR 0076) already
   reports from. A caller can ask for a period and a currency; it can never ask for an amount. The server then resolves `tier`, `commissionBp` and `amountMinor` from that derived volume and
   stores all four, so a decided payout's numbers can always be recomputed and checked against postings that already existed before the proposal was made.
3. **Maker-checker, mirroring `BookingCreditNote` (ADR 0095 part B) and `SupplierSettlement` (ADR 0077).** `AgencyCommissionPayout` is `PROPOSED` by one person; a different person `approve`s or
   `reject`s. Approval locks the agency's wallet in the payout's currency and posts exactly one `CREDIT` ledger entry, in the same transaction, keyed
   `agency:<agencyId>:commission-payout:<payoutId>` — idempotent, and the row links the entry (`@unique`) so it can never be posted twice. `(tenantId, requestId)` makes the proposal itself
   idempotent on retry. `(agencyId, periodStart, periodEnd)` is unique, so a period can be paid at most once. Every propose/approve/reject writes an immutable `AuditEvent`. A database trigger
   (`fbeds_commission_payout_guard`) refuses any update to a decided row and any delete, exactly like the credit note guard.
4. **Runs on the API connection, not the runtime role**, same reasoning as the credit note and settlement services: posting the `CREDIT` needs ledger access the booking module's narrow runtime
   role does not have (ADR 0032). `AgencyCommissionPayout` is classified finance-gated in `runtime-role-contract.ts`; row-level security is enabled and forced.
5. **Feature-gated and permissioned like its siblings.** `COMMISSION_PAYOUTS_ENABLED` must be `true` for writes; reads always work. `finance.commission.propose` and `finance.commission.approve`
   are new department permissions (`@bedbanks/contracts`), granted to no role by the migration — an operator assigns them deliberately.
6. **A scheduler proposes last month's payouts automatically** (`commission-payout-scheduler.service.ts`), one calendar month after it closes, landing each exactly where a human proposal would:
   `PROPOSED`, awaiting a different person's approval. It never approves its own work. Proposing writes an `actorType: 'SYSTEM'` audit event, which no tenant-scoped role may do under the ordinary
   `AuditEvent_tenant_insert` policy — so, following the precedent of the hold-expiry sweeper (ADR 0005), the scheduler runs on its own narrow database role (`fbeds_commission_scheduler`,
   `COMMISSION_SCHEDULER_DATABASE_URL`, migration `202612130001_commission_scheduler_system_audit`), never on the HTTP role's connection, and is off by default
   (`COMMISSION_PAYOUT_SCHEDULER_ENABLED=true`). `createCommissionPayoutRow` (`commission-payout-core.ts`) is the single row-and-audit writer shared by the HTTP service and the scheduler, so the
   tier math, the per-period uniqueness check and the audit payload shape can never drift between a human proposal and an automatic one — only the actor fields differ.
   Picking a currency when an agency holds wallets in more than one: the table allows at most one payout per agency per period (unique on `agencyId, periodStart, periodEnd`), so the scheduler
   computes every wallet currency's volume and proposes only the highest one, leaving any other currency for a human to propose by hand through the ordinary endpoint. That is a deliberate,
   documented limitation, not a silent undercount: `list()` still shows every agency with zero proposals for a currency the scheduler skipped, and nothing claims those periods are settled.

## Not done (explicit gap, not claimed)

- **Table-level grants for `fbeds_commission_scheduler` are provisioned out of band**, by the database owner, the same way `fbeds_hold_expiry`'s are (ADR 0005). This ADR and its migration add
  only the RLS policy exception; there is no automated provisioning workflow for this role yet (the hold-expiry role has one, "Provision hold-expiry role" in GitHub Actions — this role does not).
  See `docs/runbooks/commission-scheduler-role.md` for the manual steps until one exists.
- **The scheduler proposes only one currency per agency per period** (its highest-volume wallet currency that month), because the table allows only one payout per agency per period. A
  multi-currency agency's other currencies are never auto-proposed; finance proposes them by hand. Loosening the per-period uniqueness to `(agencyId, periodStart, periodEnd, currency)` would
  remove this limitation but is a schema change this update intentionally does not make.
- **The tier table is a single global default**, not yet overridable per tenant from an admin screen; `rules` exists in the calculator for exactly that extension.
