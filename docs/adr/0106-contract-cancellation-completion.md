# ADR 0106: Contract cancellation completion in Admin

Status: Accepted.

Admin cancellations must preserve the booking's sold terms and release the inventory they consumed. A no-show is a distinct financial outcome, governed by its own clause.

## Decisions

- New Agent and contract-linked manual bookings freeze contract ID/version, rate-plan ID, buyer cancellation tiers (including the client buffer), no-show clause, stay length and hotel timezone. Agent bookings also persist the plan's refundability. Existing snapshots without a timezone retain the legacy hotel-timezone interpretation; an invalid frozen timezone requires a decision.
- Manual entry offers an active rate plan for the selected hotel. The server validates tenant/hotel, supplier, currency and stay validity, resolves the named cancellation set, and derives refundability and deadline. Browser cancellation overrides on linked bookings are refused. Offline bookings outside loaded contracts retain explicit manual terms; this is not an inventory reservation or an automatic supplier booking. Fixed penalties in another currency fail closed; no implicit FX conversion is introduced.
- Percent, nights and fixed-amount penalties can be authored in both contract editors. Fixed amounts are parsed using the contract currency's minor-unit precision.
- Admin completion calls `fbeds_booking_release_cancelled_inventory(text)` in the same transaction as the status, immutable event, finance outbox and audit. It derives the tenant solely from the server-set tenant context, requires a CANCELLED booking, locks its original hold, returns sold units to their recorded plan/pool counters, and marks the hold RELEASED. Failure rolls back the entire cancellation. A released hold and an idempotent replay never return units twice. Agent cancellation retains its existing atomic release. The booking principal receives EXECUTE only, never direct inventory grants; PUBLIC has no execution permission. The SQL operation mirrors the guarded cancellation moves in `inventory-counters.ts` because the booking principal cannot execute application-side inventory queries.
- Contract-linked manual bookings use the existing cancel-and-rebook restriction for structured stay amendments, so an amendment cannot retain cancellation terms or a stay-length denominator from the old stay. Offline bookings with manually agreed terms keep their existing amendment workflow.
- Admin quotes carry the booking version. The transition checks it and performs a status/version compare-and-set, so a concurrent amendment cannot commit a stale penalty.
- `markNoShow` freezes its own quote and emits a distinct NO_SHOW money fact. Missing or malformed clauses need a Finance decision, never a zero assumption. The finance consumer and immediate settlement share the existing refund keys and booking/wallet locks. No-show refunds do not manufacture a Cancellation record. A ledger-backed no-show can be decided or waived using the existing permissions and second-person waiver check; credit notes are eligible after its invoice. Supplier liability remains for reconciliation when the buyer retains a penalty; a buyer penalty is not treated as the supplier's fee.
- Settlement sweeps include unacknowledged ledger-charged no-shows. An immutable `booking.no_show.settled` audit event acknowledges a no-show settlement, including zero refunds; repeat settlement checks the ledger before returning. A later waiver invokes settlement again. Non-ledger manual bookings are handled by the existing finance posting consumer.

## Deployment and rollback

Deploy the forward migration before the API, regenerate Prisma, and provision/verify the booking principal. No existing booking terms or balances are rewritten. Counter lookup indexes are documented in the migration; RLS and table grants remain unchanged. Rollback the application first, revoke execution, and drop the new function in a reviewed forward migration. Retain the enum value and existing immutable financial/audit history. Do not run a counter repair against historic cancellations without reconciling their actual supplier and inventory state.

## Verification

Unit coverage checks timezone drift, provenance, fixed amounts, distinct no-show clauses, unknown terms, integer rounding/caps, browser override refusal and idempotent posting. PostgreSQL coverage checks limited-role release/replay, tenant isolation, rollback of a failed release, no-show refunds without cancellation records, and contract-linked manual entry/replay after contract suspension.

The migration also leaves the existing audit lookup indexes intact: no-show acknowledgement queries bind `entity_type = booking`, `entity_id` and tenant, allowing the existing entity index to serve per-booking retries. The sweep is bounded and ordered by the existing tenant/status/update index.
