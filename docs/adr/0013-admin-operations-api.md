# ADR 0013: Admin operations API and the runtime-role boundary

## Status
Accepted for the API and Admin code. The production database grants described under "Open decision" are **not** applied and need a human owner.

## Context
Admin only had supply screens. Bookings, holds, reconciliation, cancellations, wallets, ledger, audit and connectors rendered "not enabled" placeholders, so an operator could not see why a Dubai hotel was or was not sellable, or what happened to a booking, without SQL.

The production API connects as `fbeds_api_login` (ADR 0008): non-bypass, SELECT-only on supply tables, with no grants on `Booking`, `Wallet`, `LedgerEntry`, `InventoryHold`, `BookingDocument`, `Cancellation` or `Connector*`. The role self-check enforces that absence. That boundary is deliberate.

## Decision
1. Add a read-only `admin/operations/*` API (`apps/api/src/admin-operations`, contracts in `@bedbanks/contracts`). The only write is `POST /admin/operations/reconciliation/run`, which calls the existing idempotent `BookingReconciliationService`. Admin sets no booking, hold, ledger or inventory state itself, and there is no generic status override.
2. Tenant comes from `TenantContextGuard` only. Every handler declares a permission through the existing `AgentRbacGuard` (`booking.read`, `booking.reconcile`, `booking.cancel`, `finance.read`, `audit.read`); a spec fails if a handler lacks one. Hotels, suppliers and readiness additionally require the existing `supply.*.read` permissions.
3. Sellability is computed server-side by the existing `evaluateNightSellability` plus the room-mapping gate; consistency flags come from one pure function (`booking-attention.ts`). Nothing authoritative is computed in React.
4. A PostgreSQL `42501` from the runtime role becomes HTTP 503 with code `OPERATIONS_READ_DENIED`, and the Admin renders a distinct "not readable by the API role" state. It is never an empty list and never zeros. Dashboard sections return `{state:'unavailable'}` instead of fake counts.
5. Lists are server-paginated (default 25, max 100) with strict validated filters (identifier shapes, enums, calendar days, prefix match only; no wildcard search). Snapshot-derived filters scan a bounded newest-first window (500 rows) and say so.
6. Documents are rendered only if already issued. Admin never issues one.
7. `Wallet.cached_balance` is not maintained by any code path, so it is not shown. The ledger sum is the only balance authority.

## Open decision (human-owned): production read access
Until grants exist, the transaction views return `OPERATIONS_READ_DENIED` on the production runtime role. Supply writes from Admin are likewise outside that role's grants (existing ADR 0008 behaviour). Options:
- **A (recommended).** A separate NOLOGIN `fbeds_ops_read` group with SELECT only on `Booking`, `InventoryHold`, `InventoryHoldNight`, `Cancellation`, `LedgerEntry`, `Wallet`, `BookingDocument`, `ConnectorDefinition`, `ConnectorExecution`, and a view exposing only `purpose` and a presence boolean for connector credentials. The Admin API process uses it. `ConnectorCredentialReference` stays ungranted.
- **B.** Widen `fbeds_api` with the same SELECTs and update the self-check. Simpler, but it enlarges the blast radius of the process that serves Agent traffic.
Reconciliation needs write privileges that neither option grants; it remains an operator action through a privileged path until a human decides. This ADR does not change any grant.

## Consequences
- Runtime RLS for these tables is proven under a non-bypass test role (`ADMIN-RLS`), not under the production login role: `RUNTIME_RLS=BLOCKED` for transaction tables until the grants above exist.
- Rollback: remove `AdminOperationsModule` and the `admin/operations` routes; Admin pages revert to placeholders. No schema or migration was changed.
