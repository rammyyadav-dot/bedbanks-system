# Operations, Bookings & Reservations: completion gap analysis (2026-10-30)

Written from the code and migrations on this branch, not from the module's self-reported percentage. It answers a five-step "last 10%" plan. Each step is marked **Built**, **Added here**, or **Needs a decision** (a decision the repository's own ADRs reserve for the owner). Nothing below is presented as a capability unless it runs.

| Step | Plan item | State | Evidence |
| --- | --- | --- | --- |
| 1 | Scan for expired holds every minute, release inventory | **Built**, gated | `HoldExpirySweeper` (`apps/api/src/agent/hold-expiry-sweeper.service.ts`), ADR 0005. Default interval 60 s. Off until `HOLD_EXPIRY_SWEEP_ENABLED=true` and the restricted role is provisioned (`docs/runbooks/hold-expiry-role.md`). |
| 1 | Stuck `PENDING_SUPPLIER` bookings | **Built**, operator-run by design | `BookingReconciliationService` + `booking.reconcile` (ADR 0005 addendum explains why it is not a timer). Flags: `RECONCILIATION_REQUIRED`, `PREBOOK_EXPIRED_UNRESOLVED` (`booking-attention.ts`). |
| 1 | `PENDING_PAYMENT` / `HELD` / `EXPIRED` **booking** statuses | **Does not apply** | `BookingStatus` is `PENDING_SUPPLIER, ON_REQUEST, CONFIRMED, AMEND_REQUESTED, CANCEL_REQUESTED, CANCELLED, CHECKED_OUT, NO_SHOW, REJECTED, FAILED`. `HELD` and `EXPIRED` are `InventoryHoldStatus` values. Payment is wallet/credit, authorised before the supplier call. Adding statuses would touch every transition writer. |
| 1 | BullMQ / Redis worker | **Needs a decision** | `docs/booking-concurrency-foundation.md`: Redis is `INTERFACE ONLY` until an owner approves infrastructure, secret references and fencing. PostgreSQL stays authoritative; Redis expiry must never restore inventory. |
| 1 | Webhook to the agent portal on expiry | **Needs a decision** | No outbound webhook subsystem exists in `apps/api/src` (signing, retry, subscription storage, SSRF policy). Wanted before this: ADR 0075 (B2B distribution API) is the natural home. |
| 2 | Voucher, invoice, cancellation receipt | **Built** (HTML) | `booking-finance-documents.ts`, `BookingDocument` (issue-once, immutable), emailed through the outbox (ADR 0066). |
| 2 | PDF rendering | **Needs an engine choice** | ADR 0066 "Not built": "a PDF renderer is a separate decision". English only (owner decision), so no right-to-left or complex-script shaping is needed: a lightweight engine (PDFKit or `@react-pdf/renderer`) is enough and no headless browser has to ship in the ECS image. |
| 2 | Supplier reservation email / fax / XML to the hotel | **Needs a decision** | Hotel reservation contacts are not modelled as a send-to address with consent; outbound supplier mail is a new PII and deliverability surface. Supplier XML belongs in a connector package (invariant 9). |
| 3 | Cancellation tiers, free-cancel deadline, penalty | **Built** | `CancellationPolicyService.quote/freeCancellationDeadline`, `buildPenaltyQuote`. Hotel-local midnight, integer minor units, fails closed. |
| 3 | Whole penalty timeline | **Added here** | `CancellationPolicyService.penaltySchedule()` + 4 tests: every tier priced by `quote` at its own start instant, so it cannot disagree with a live quote. Not yet exposed on an API route (see below). |
| 3 | Differential cost on amendment | **Built**, supplier-priced | `amendmentDifference`, `amendedNetAndMarkup`, `applyAmendmentDecision`. The new price is the *supplier-confirmed* sell recorded at approval; the system does not invent a rate. Inventory-backed bookings are refused (ADR 0101). |
| 3 | Automatic rate re-pricing and amendment fees | **Needs a decision** | Requires a re-search against the supplier/contract engine for the new stay, an amendment-fee policy (none is stored on contracts), and a ledger adjustment path for ledger-charged bookings (`ledgerRequired` refusal today). |
| 4 | Exception flagging | **Built** | `bookingAttention` (read-only flags) and the Operations queue with SLA rules (`booking-ops-queue.service.ts`). |
| 4 | Force-confirm, re-route, administrative refund with user + reason code | **Needs a decision** | Nothing exists. Force-confirm asserts a supplier confirmation the supplier did not give; a refund is a ledger mutation (`check:ledger-single-writer`); both need maker-checker (`approvals`, ADR 0095), a reason-code taxonomy, new permissions, audit events and a reviewed migration. Proposed in ADR 0105. |
| 5 | No double-booking at the last unit | **Built** | Ordered conditional `UPDATE` (`sold + held + n <= allotment`) in one tenant transaction, DB check constraints, idempotency key. Pool variant tested by `POOL-01` (30 concurrent requests over 5 rooms sell exactly 5) in `apps/api/test/inventory-pool.e2e-spec.ts`. This is an atomic conditional update, not `SERIALIZABLE` or `FOR UPDATE`; booking-row mutations do use `FOR UPDATE` (`loadAmendmentSubject`, lifecycle close). |
| 5 | k6/Artillery load script | **Added here, not run** | `tools/load/last-room-hold.k6.js`. k6 is not installed in this environment and there is no seeded database here, so it has not been executed. |

## Running the contention test

```bash
k6 run -e BASE_URL=... -e OFFER_ID=... -e SEARCH_ID=... -e SELL_MINOR=100000 -e CURRENCY=AED \
  -e UNITS_AVAILABLE=1 -e HEADERS_JSON='{"Cookie":"..."}' tools/load/last-room-hold.k6.js
```

Pass criteria: `holds_created <= UNITS_AVAILABLE`, `holds_unexpected_response == 0`. Then confirm server-side, as the owner role, for the offer's rate plan and night:

```sql
SELECT stay_date, allotment, sold, held,
       (sold + held) <= allotment AS within_allotment
FROM "DailyAvailability"
WHERE tenant_id = '<tenant>' AND rate_plan_id = '<plan>' AND stay_date = '<night>';
-- expect held = UNITS_AVAILABLE and within_allotment = true
```

Pooled plans count on `InventoryPoolDay` (`capacity`, `sold`, `held`), not the plan row.

## Not yet wired

`penaltySchedule()` has no route or contract. Per invariant 4 the envelope must be added to `@bedbanks/contracts` before a frontend consumes it, and it needs a permission-checked controller; that is a small follow-up once Operations confirms where the schedule is shown (booking detail and the voucher are the candidates).

## Owner decisions received (2026-10-30)

Redis approved (coordination only, BullMQ not adopted); hotels reached by email and channel-manager XML; recommendations accepted for webhooks, PDF and overrides. Recorded in ADR 0106. Built so far: the Redis single-runner guard on the hold sweeper, and the notice builders (OTA XML and English email). Also built and verified on PostgreSQL: the hotel notice outbox and email dispatcher, addressed from the hotel profile's reservations email (AMEND/CANCEL queuing and XML delivery are not built). Still to build, in order: AMEND/CANCEL notices, webhooks, PDF, ADR 0105 overrides, `penaltySchedule` route.

## Decisions that were needed (answered above)

1. Is Redis/BullMQ approved, or does the in-process sweeper plus the Operations queue stand? (Recommendation: stand; the sweeper already meets the one-minute cadence and Redis adds a second source of truth.)
2. Outbound webhooks to agent portals: in scope for ADR 0075?
3. PDF engine and languages (and who supplies/approves translated tax-invoice text).
4. Supplier reservation channel: email, channel-manager XML, or neither for contracted inventory.
5. Override powers: which actions, which roles, maker-checker or not, and the reason-code list (ADR 0105 proposes defaults).
