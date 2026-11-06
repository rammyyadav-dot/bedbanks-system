# ADR 0113: Booking transaction role

Status: accepted for this change. Accepting it enables nothing: `BOOKING_ENABLED` stays unset, and `BOOKING_TRANSACTION_DATABASE_URL` stays unset until an operator provisions the role for a named environment.

## Context

Agent hold, prebook, confirm, cancel, document and reconciliation services open `withTenant` and write bookings, holds, inventory counters, the ledger and wallets. Those writes are privileged paths of `fbeds_api` (ADR 0032, ADR 0101). Setting `BOOKING_ENABLED=true` only opens the HTTP routes. On the strict API login the statements fail, and widening `fbeds_api` would give every request the booking and finance writes this role is meant to withhold.

`fbeds_booking_ops` is the Admin booking principal. It is forbidden `LedgerEntry`, `Wallet`, `InventoryHold` and `Cancellation`, so it cannot serve this path.

## Decision

A NOLOGIN group `fbeds_booktx` and one LOGIN member `fbeds_booktx_ops` (`CONNECTION LIMIT 10`, `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`). The Agent mutation services inject `BookingTransactionDatabase`, which reads `BOOKING_TRANSACTION_DATABASE_URL` and refuses when that URL is unset or equal to `DATABASE_URL`. It never falls back to the API client or the owner. A missing credential is HTTP 503 `BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE` before any query.

The owner provisions the role with `ops:provision-booking-transaction-role` (`PROVISION_DATABASE_URL` plus `BOOKING_TRANSACTION_LOGIN_PASSWORD`). Migrations do not grant it (SR-07). `ops:verify-booking-transaction-role` connects as the login and checks the catalogue and `WHERE false` probes.

Grants, and nothing broader:

- INSERT on the booking, hold, ledger, supplier-mutation, audit and wallet tables the transaction writes. No DELETE. No table-wide UPDATE.
- UPDATE on named columns only: booking lifecycle and supplier answer, hold release, supplier-mutation progress, `DailyAvailability` and `InventoryPoolDay` `held`/`sold`, `Cancellation.refund_minor`, and `Wallet.updated_at` so `SELECT … FOR UPDATE` can lock the row.
- SELECT on the tables the transaction must freeze and price, and column-only SELECT on hotel profile times and local charges, the tenant name, the agency name, membership, the credit-limit amount, the FX rate, and the `RoomSalesRule` mode, cap and scope keys that `reserveNight` reads before it moves `held`. The rule reason, actor and batch stay unreadable. No hotel contacts, no users, sessions, memberships, funding receipts, connector credentials, or finance-posting tables.

## Amendment: sales-rule read (2026-11-06)

`reserveNight` always reads `RoomSalesRule` before taking stock, including when no rule exists. Without that SELECT the hold fails closed as unavailable and writes nothing. The grant is the columns that query names, not the operator note. `AgencyCreditLimit.id` and `FxRate.id` are readable as well, because Prisma selects the primary key of a `findFirst` even when the caller names other columns. Approver and note columns stay unreadable.

The contracted prebook proof reads the claimed hold through this login, because the API role cannot see offer or search columns on `InventoryHold`. Agency membership stays on the API role: confirmation resolves the caller's agency there, then the booking transaction only locks that agency's booking.

Two triggers, created by migration `202612200001_booking_transaction_role_guards`, apply only when the session is a member of `fbeds_booktx`:

- A wallet insert must be an agency account with `credit_limit = 0` and `cached_balance = 0`. A house account is refused.
- A ledger insert must be one of `booking:<id>:authorize` (HOLD, negative), `:authorize:release` or `:authorize:settle-release` (RELEASE, positive), `:authorize:settle-debit` (DEBIT, negative), or `:cancel-refund` (REFUND, positive). The reference must match `^booking:[A-Za-z0-9_-]+$`.

Other roles are not members, so their ledger and wallet writes are unchanged. The ledger hash chain stays a `SECURITY DEFINER` trigger; this role has no write on `LedgerChainLink`.

## Consequences

`BOOKING_ENABLED` remains an owner decision per environment (ADR 0101) and is still insufficient on its own. The hold-expiry sweeper keeps `HOLD_EXPIRY_DATABASE_URL`. Finance posting, funding and Admin booking operations keep their own principals. A bug that posts a credit or a non-zero wallet fails closed as 503.

## Rollback

Stop setting `BOOKING_TRANSACTION_DATABASE_URL` and restart the API. The routes return 503 and write nothing. To remove the guards, apply the forward rollback noted at the top of the migration, then `deprovisionBooktxRole` from an owner session. Existing bookings, holds and ledger rows are left in place.
