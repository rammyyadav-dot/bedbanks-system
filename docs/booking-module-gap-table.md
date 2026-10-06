# Booking module: gap table (spec against `main` `a2bc9dd`)

Source: `docs/booking-module-spec.md` and its 2026-10-06 decisions. Written before any booking code change. "Exists" names a file that was read; nothing here claims a test result.

## Vocabulary mapping (needs owner confirmation, see ADR 0039 question 2)

| Spec word | Repo model | Why |
|---|---|---|
| Tenant (Travel Republic, Atlas Getaways …) | `Agency` (`/admin/clients/agencies`) | In the repo a `Tenant` is the bedbank operator and the isolation boundary (forced RLS). The spec's customers are agencies inside it |
| Agent | `User` who is an `AgencyMember` | A user belongs to at most one agency per tenant |
| Tenant admin / "own tenant" scope | Agency-scoped user: sees bookings of their agency only | Needs an `agencyId` on the booking and an agency filter in the data layer, on top of tenant RLS |
| "View all tenants' bookings" | All agencies of the operator tenant | Cross-operator-tenant reads would break invariant 1 and forced RLS and are not proposed |

## Data model

| Spec field or table | Exists | Gap |
|---|---|---|
| `booking.ref` | `Booking.reference` (unique), format `FB-` + 20 hex of a hash of tenant and idempotency key | Spec says `FB`+YYMMDD+6 digits "as today"; that is not today's format. Existing references stay. Question 3 |
| `status` (10 values) | `BookingStatus`: PENDING, CONFIRMED, CANCELLED, FAILED | Add PENDING_SUPPLIER (rename of PENDING), ON_REQUEST, AMEND_REQUESTED, CANCEL_REQUESTED, CHECKED_OUT, NO_SHOW, REJECTED. Every writer and reader of `status` changes (about 20 source files and 20 suites). `Closed` is `closedAt`, not a status (decision 2) |
| `supplier_status`, `supplier_ref`, `hotel_conf_no` | `SupplierMutation.supplierReference` and `supplierStatus` per mutation; `Booking.supplier` is a free string | Add `supplierStatus`, `supplierRef`, `hotelConfirmationNo` on `Booking`; keep `SupplierMutation` as the journal (extend, do not duplicate) |
| `agent_id`, `channel`, `agent_ref` | None (`createdByRequestId` only) | Add `agencyId`, `agentUserId`, `channel`, `agentRef` |
| `hotel_id`, `check_in`, `check_out`, `nights` | `hotelId`; dates only inside `searchSnapshot` JSON | Promote to indexed columns, backfilled from the snapshot |
| `currency`, `sell_amount` | `currency`, `totalMinor` | Map `sell_amount` to `totalMinor`; add `netMinor`, `markupMinor`, `fxRate` (decimal, frozen) with integer minor units |
| `payment_mode`, `payment_status`, `is_refundable`, `cancel_deadline` | Ledger entries and cancellation policy exist elsewhere | Add columns; deadline in UTC, shown in hotel local time |
| `is_urgent` (computed) | `booking-attention.ts` computes reconciliation flags | Urgent is computed by SLA rules (Phase 4), never stored as a free flag; a materialised column only if the list needs it |
| `assigned_to`, `version`, `closedAt` | None | Add |
| `booking_room` | Room and occupancy in `searchSnapshot` | New table, backfilled |
| `booking_guest` | Only `leadGuest` {firstName, lastName} in the snapshot | New table (personal data: masked for read-only roles, unmasked views audited) |
| `booking_snapshot` | `Booking.searchSnapshot` JSON | Map: keep `searchSnapshot` as the frozen intake snapshot; add a versioned snapshot table only when amendments arrive (Phase 2/3) |
| `booking_event` | `AuditEvent` rows with `booking.*` actions | New immutable `BookingEvent` written in the same transaction as the status change (decision: one `transitionBooking`); audit event also written |
| `supplier_call` | `SupplierMutation` (status, fingerprints, no payloads) | New `SupplierCall` for request/response logging with redaction rules; raw payloads admin-only, never logged |
| Indexes | `(tenantId, status)`, unique `(tenantId, idempotencyKey)` | Add `(tenantId, status, checkIn)`, `(tenantId, supplierRef)`, `(tenantId, cancelDeadline)`, `(tenantId, agencyId)` |

## Behaviour

| Spec item | Exists | Gap |
|---|---|---|
| Admin list and detail | `GET /admin/operations/bookings`, `/:bookingId` (`operations-transactions.service.ts`), Admin `bookings` and `bookings/[id]` pages | Filters, chips, columns, Kanban, URL state, tabs: build on these routes, do not add a second list |
| Lifecycle engine | `booking-transaction-state.ts` governs the hold/prebook transaction (RECHECKED … CONFIRMED), a different machine | New booking-status machine and the single `transitionBooking`; the transaction machine stays |
| Supplier adapter and queue | `SupplierAdapter` port (`agent/supplier.port.ts`), `SupplierMutation` journal, `supplier-prebook-orchestration` | No job table, no retries schedule, no mock adapter with configurable outcomes |
| Cancellation | `booking-cancellation.service.ts`, `Cancellation` | Spec's Cancel requested then Cancelled, penalty from frozen policy, non-refundable second confirmation |
| Finance | `LedgerService`, `FinanceService`, wallets | Emit events; never edit balances; existing services keep posting |
| Documents | `BookingDocument` VOUCHER, INVOICE, CREDIT_NOTE; HTML render | Cancellation note, adjustment invoice, white-label rules (no net rate or supplier name) |
| Notifications, webhooks | None for bookings | Phase 5, log-only mailer in dev |
| Urgent and SLA | Reconciliation attention flags only | Phase 4 |
| Permissions | `booking.read`, `booking.reconcile`, `booking.cancel`; `booking.status.update` and `booking.confirm` are FORBIDDEN keys | Map spec names to new `booking.*` keys (ADR); status changes only through the service, never through a "status update" permission |
| Booking enablement | `BOOKING_ENABLED=false`; Agent routes return `booking_unavailable` | Unchanged. `ADMIN_MANUAL_BOOKING_ENABLED` (default false) added in Phase 2 |

## Database privileges (blocking)

The strict API runtime role (`fbeds_api`) has **no** grants on `Booking`, `BookingDocument`, `SupplierMutation`, `InventoryHold` writes, `LedgerEntry` or `Wallet` by design ("booking is disabled; finance-gated", `runtime-role-contract.ts`, `docs/strict-runtime-db-role.md`). The existing Admin booking views therefore return the sanitized 503 `OPERATIONS_READ_DENIED` under that role. A DB-backed booking list in a strict-role deployment needs a reviewed privilege design first (ADR 0039 question 1).
