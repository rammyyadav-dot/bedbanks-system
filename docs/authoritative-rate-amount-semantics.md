# Authoritative daily-rate amount semantics

`DailyRate.amountMinor` previously had no durable declaration of whether it represented a supplier NET amount or an agent-facing SELL amount. Search cannot safely infer this distinction: treating NET as SELL can expose confidential commercial rates, while adding an unapproved markup creates a fabricated price.

## Decision

Every newly created or updated daily rate must declare `amountBasis` as `NET` or `SELL`.

- `SELL` is an explicitly approved agent-facing amount and may become eligible for a future database inventory adapter after all other mapping, contract, occupancy, availability and policy checks pass.
- `NET` remains non-sellable until an authoritative markup policy is implemented and approved.
- `NULL` identifies a legacy or unclassified row. It always fails closed with `RATE_AMOUNT_BASIS_UNVERIFIED`.

The migration deliberately leaves existing rows `NULL`. It does not backfill or guess commercial meaning. Classification of existing rates is an owner-controlled data-governance operation outside this change.

## Sellability outcomes

The existing sellability check now includes held inventory in its availability calculation and emits:

- `RATE_AMOUNT_BASIS_UNVERIFIED` for legacy or unclassified rates.
- `NET_RATE_MARKUP_UNAVAILABLE` for NET rates until markup governance exists.

No floating-point calculation, currency conversion or markup calculation is introduced.

## Release limits

The forward-only migration may be replayed and tested only in disposable PostgreSQL CI. Persistent execution requires the approved database inventory, backup and restore evidence, role/RLS review, qualified human review and database-owner authorization.
