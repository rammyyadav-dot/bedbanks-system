# ADR 0113: Booking execution role

## Status

Accepted.

## Context

Agent booking is one database transaction: the hold, the prebook, the confirmation (held becomes sold, and the ledger posts HOLD, RELEASE and DEBIT), the cancellation (sold is returned, a REFUND is posted, a Cancellation row is written), the documents, and the reconciliation of a stale hold. Those services use `PrismaService`.

The strict API runtime role, `fbeds_api`, is forbidden to write `Booking`, `InventoryHold`, `LedgerEntry`, `Wallet`, `Cancellation`, `SupplierMutation` and the held and sold counters (ADR 0032, ADR 0039, ADR 0076). Setting `BOOKING_ENABLED=true` does not add those grants. A deployment that turns the flag on while the API still connects as `fbeds_api` cannot finish the transaction. Using the database owner, or `GRANT ALL`, would hide that gap.

The Admin booking role (`fbeds_booking`, ADR 0039) stays unable to write the ledger. The finance posting role (`fbeds_finpost`, ADR 0076) stays the only writer of `BookingFinancePosting` and `SupplierPayableEntry`. The hold-expiry sweeper keeps `HOLD_EXPIRY_DATABASE_URL`.

## Decision

1. **A new NOLOGIN group, `fbeds_booking_exec`, and one LOGIN member, `fbeds_booking_exec_ops`.** The connection is `BOOKING_EXECUTION_DATABASE_URL`. It must differ from `DATABASE_URL`. The application never falls back to the owner or to `fbeds_api` once that URL is set.
2. **Fail closed when sales or servicing is on.** If `BOOKING_ENABLED` or `BOOKING_SERVICING_ENABLED` is `true` and the execution URL is unset or equal to `DATABASE_URL`, the booking services answer `503` with code `BOOKING_EXECUTION_UNAVAILABLE`. The flags stay off by default. This ADR does not set them in Terraform or `render.yaml`.
3. **Grants are the columns that one agent transaction touches.** SELECT on the booking, hold, ledger, wallet, counter and catalogue tables the transaction joins. INSERT on the rows the transaction creates, including `LedgerEntry`, `Wallet` (the agency account on first use) and `AuditEvent`. UPDATE only of:
   - `Booking`: status, supplier, search snapshot, supplier status, supplier reference, hotel confirmation number, version, closed_at, updated_at
   - `InventoryHold`: status, released_at, updated_at
   - `DailyAvailability` and `InventoryPoolDay`: held, sold, updated_at
   - `Wallet`: updated_at only, so `SELECT … FOR UPDATE` can lock the row
   - `SupplierMutation`: status and the acknowledgement columns, not the request fingerprint
   - `Cancellation`: refund_minor
4. **What this role cannot do.** No DELETE. No table-wide UPDATE. No change to `total_minor`, a credit limit, `cached_balance`, allotment, pool capacity, a ledger row, a price, or a credential. No read of `users`, `sessions`, `ConnectorCredentialReference`, `FundingReceipt`, `DailyRate`, or `HotelProfile.contacts`. `BookingFinanceEvent` is readable only for the penalty columns settlement already uses; this role does not insert those events. `BookingFinancePosting` stays with the finance posting role.
5. **Row-level security still applies.** The role is not superuser, has no `BYPASSRLS`, and owns no table. `provisionBookingExecutionRole` revokes every table, function and column privilege on the group before it grants.
6. **The strict runtime contract does not grow.** `fbeds_api` still has none of these writes. ADR 0101 gate 2 is this role, not a wider API login.

## Consequences

- An operator provisions the role with `ops:provision-booking-execution-role`, stores the login URL as a secret, and certifies it with `ops:verify-booking-execution-role` while connected as that login. The runbook is `docs/runbooks/booking-execution-role.md`.
- Disposable tests that leave both flags unset keep using the injected client, so existing owner-backed suites still run. A suite that sets `BOOKING_ENABLED=true` must provision this role first.
- Funding, cached-balance maintenance and finance posting stay on their own roles. `LedgerService.post` is not moved here.
