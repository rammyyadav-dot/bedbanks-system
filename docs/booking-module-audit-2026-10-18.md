# Booking / reservation module: CTO audit and build log (2026-10-18)

Scope: Admin booking module (`apps/admin` bookings screens, `apps/api/src/booking-ops`, `admin-operations`, `packages/contracts`), read against `docs/booking-module-spec.md`, ADR 0039, the gap table, and the Booking Enquiries reference screen. Everything marked **verified** was read in code or run in this session; nothing here is inferred from documentation alone.

## 1. Verdict

**Amber, and further along than the status docs suggest.** The lifecycle, supplier-queue, operations-queue, money-fact, document, saved-view and bulk layers are built to a high standard (single writer, compare-and-set, idempotency keys, append-only events, forced RLS, a dedicated least-privilege database role). Until this change the list lacked four things the reference screen and the spec both call for: Excel/CSV export, Print, the Kanban board, and a live "needs action" counter. Those are built now (Phase 6D, section 5).

The module is **not production-activatable** and must not be described as such, for reasons that are about supply, not UI (section 4): there is no production supplier adapter, the module records money facts but does not post them, and `BOOKING_ENABLED` is correctly still `false`.

## 2. Standard bedbank booking workflow against what exists

| Stage (industry standard) | State | Evidence |
|---|---|---|
| Rate recheck and prebook before booking | Foundation only; needs a live supplier to certify | `agent/*prebook*`, `docs/supplier-recheck-hold-boundary.md` |
| Credit / prepayment authorisation | Built in Agent flow; finance-gated | `booking-financial-authorization.service.ts` |
| Book through a queue, never inline | Built (database-backed queue behind an interface; SQS swap-in not done) | `booking-supplier-jobs.service.ts`, `booking-supplier-runner.service.ts` |
| Timeout never creates a ghost or duplicate | Built and tested against the mock: status check by our reference before Failed; UNKNOWN is never FAILED | runner, `mock-ghost`/`mock-down` scenarios, `booking-supplier` e2e |
| Confirmed / On request / Rejected / Failed | Built | `booking-transition.ts`, ten-value `BookingStatus` |
| Missing supplier-ref follow-up | Built (chip, flag, ops-queue reason) | `booking-ops-queue.ts` |
| Voucher, invoice, credit note, cancellation note | Built, immutable; voucher hides net and supplier | `booking-document*.ts` |
| Cancellation with frozen policy, penalty fixed at request time, non-refundable second confirmation | Built | `booking-penalty-quote.ts`, `booking-transition.ts` |
| Amendment request / approve / reject | Built (ADR 0072): dates and occupancy applied with the supplier-confirmed price; no ledger adjustment, no reissued documents | `booking-amendment.ts` |
| No-show within 7 days of check-in | Built (manual) | `NO_SHOW_WINDOW` rule |
| Auto Checked-out | Built in Phase 6E (scheduled job, off by default) | `booking-lifecycle-jobs.service.ts` |
| Close after dispute window | Built in Phase 6G, off until the owner sets `BOOKING_CLOSE_AFTER_DAYS` (no default: the length is still the owner's decision) | `booking-lifecycle-jobs.service.ts` |
| Work queue, SLA, assignment, escalation | Built; one SLA policy per deployment | `booking-ops-queue.service.ts` |
| Saved views, bulk assign/acknowledge | Built | Phase 6B/6C |
| Export, print, board, header counter | **Built in this change** | section 5 |
| Supplier-initiated cancellation, nightly supplier reconciliation | Not built | ADR 0039 Phase 3/4 |
| Offer alternative; rebook from Failed | Not built | ADR 0039 Phase 2 |
| Guest / agent notifications and tenant webhooks | Partial: a checkout confirmation email outbox exists (ADR 0066, not re-audited here); per-status notifications and signed tenant webhooks are not built | `booking-ops/email/*` |
| Ledger posting and supplier payables from booking events | Not built: the module writes an append-only outbox ("awaiting Finance booking") and moves no money | ADR 0039 Phase 5 |

## 3. Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High (data egress) | Export was only a `planned` permission; no route, no audit, no cap. Any export must be permission-gated, scoped, masked like the list, capped and audited **before** the file is released. | Fixed (section 5) |
| F2 | Medium | A CSV cell starting `=`, `+`, `-`, `@` (also after leading spaces or line breaks) runs as a formula in Excel. Guest names and supplier references are free text. | Fixed: neutralised; a unit test found and closed the leading-line-break variant |
| F3 | Medium | The global `ResponseInterceptor` wraps any returned string in `{ "success": true, "data": … }`, which would have shipped a JSON-wrapped "CSV". Found only by running the route over HTTP against Postgres, not by unit tests. | Fixed: `@Res()` like the existing hotel and compliance exports |
| F4 | Medium | Approved amendments changed status only; dates, room and occupancy were not applied or priced. | Built (ADR 0072, branch `claude/booking-amendments`): dates and occupancy, supplier-confirmed price recorded by the approver, applied atomically, difference recorded as a money fact. Not built: ledger adjustment (refused on ledger-charged bookings), re-pricing from the rate engine, revised documents, name changes |
| F5 | Medium | Confirmed bookings never moved to Checked out automatically, and nothing closes terminal bookings after the dispute window (window length is still an open owner question). | Checked-out job built (Phase 6E, merged); close-after-dispute built (Phase 6G, branch `claude/booking-close-job`), inert until the owner sets the window |
| F6 | Medium | No production supplier adapter: only the mock (named tenants) and the XML connector kit. Unknown external outcomes must stay "pending investigation". | Open (release gate) |
| F7 | Low | The list showed reconciliation attention tags but not the SLA "Urgent" badge the reference screen shows. | Built (Phase 6F, branch `claude/booking-urgent-badge`): the badge is the queue's own verdict; no "Only urgent" filter |
| F8 | Low | One SLA policy per deployment; the spec wants per-tenant-contract overrides. | Open |
| F9 | Info | The strict API role has no grants on booking tables by design; the booking role (`fbeds_booking_ops`) must be provisioned or the screens correctly answer 503. | By design |

## 4. Release gates still open (not UI work)

1. A certified live supplier adapter with independent canonical IDs and authoritative prices.
2. A Finance consumer of `BookingFinanceEvent` (ledger posting, supplier payable creation) under the single-writer ledger rule.
3. Amendment re-pricing and supplier amendment calls (F4).
4. Scheduled jobs: Checked-out, close-after-dispute, nightly supplier reconciliation, supplier-initiated cancellation intake (F5).
5. Per-status notifications and signed tenant webhooks.

## 5. Built in this change (Phase 6D)

- **Export** `GET /admin/operations/bookings/export`: same `BookingQueryV1` grammar and scope as the list; `booking.export` (operator) or `booking.export.agency` (agency, own agency only), formal roles only, no role granted by the migration; at most 1,000 rows, above which it is refused (422 `BOOKING_EXPORT_TOO_LARGE`), never truncated; guest names masked and net/margin hidden exactly as in the list; money as integer minor units rendered by integer arithmetic; formula-injection safe; an audit event (`booking.exported`, plus `booking.pii.exported` when names are unmasked) is written before the file is returned, and it stores which filters applied but never their values.
- **Print**: browser print of the page as shown, A4 landscape, chrome and controls hidden, print heading with timestamp and applied filters.
- **Kanban**: a read-only board (On request, Pending supplier, Confirmed, Amend requested, Cancel requested, Failed). Each column loads independently from the list API with the person's filters; a failed column shows a failure, never an empty column. A card opens the booking, where every legal action already lives. There is no drag-to-change-status, so the board cannot put a booking in a state the API would refuse.
- **Header counter**: "N need action"; shown only when it was read, never as 0 on failure.
- Migration `202611230001_booking_export_permissions`: data only, two permission rows, rollback documented in the file.

### Deliberate deviations from the spec
- Asynchronous export above 1,000 rows with an emailed link is **not built**. Above the cap the API refuses and says how to narrow. A background job and an email channel are an owner decision (see Phase 5 notes).
- Drag-and-drop on the board is not built (reason above).

### Verification
- Unit: `booking-export.spec.ts` (8), admin `booking-export-ui` and `booking-kanban-ui` (10), controller wiring spec updated.
- Real database: all 86 migrations applied to a disposable PostgreSQL 16 with pgvector; `booking-export.e2e-spec.ts` (8 tests: scope, permission, masking, net visibility, agency isolation, cross-tenant isolation, hostile cells, bad queries, limit, audit) plus `booking-read`, `booking-query`, `booking-bulk`, `admin-operations` e2e suites pass under the strict runtime role.
- `pnpm check:architecture`, API / Admin / contracts type-check, ESLint on changed files pass.
- **Not done**: the React screens (Kanban, toolbar, print layout) were type-checked and their pure logic unit-tested, but not rendered in a browser in this session. Run `tools/admin-ops-verify` before release.

## 6. Recommended next order
1. Finance consumer for the money outbox (unblocks payables and revenue reporting).
2. Scheduled jobs (F5), starting with auto Checked-out, which is already a defined system action.
3. Amendment re-pricing (F4).
4. Urgent badge on list rows (F7), reusing the queue ruleset.
5. Async export and notifications once the owner chooses an email provider and tenant channels.
