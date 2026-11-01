# Supplier extranet: workflow, function and business-rule audit

**Date:** 2026-10-28 · **Scope:** `apps/supplier` and the `apps/api/src/supplier-extranet` module it calls, plus the booking paths a supplier answer touches (`booking-transition`, `booking-confirmation`, `booking-reconciliation`, `booking-finance-events`).
**Method:** code reading of the current `main`, ADR 0061 (all amendments), and the quality gates below. No database was available, so nothing here was reproduced end to end; findings marked *code-verified* rest on the cited lines, not on a failing test.

**Gates run this session**

| Gate | Result |
|---|---|
| `apps/supplier` type-check | pass |
| `apps/supplier` lint | pass |
| `apps/supplier` unit tests | 16 / 16 pass |
| `apps/api` `src/supplier-extranet` unit tests | 59 / 59 pass |
| Supplier e2e (`e2e/tests/04-supplier-extranet.spec.ts`, API e2e specs) | **not run** (needs PostgreSQL and the API) |
| `pnpm check:architecture`, full `pnpm test`, `next build` | not run |
| Login page in a real browser (desktop and phone width) | looked at; sign-in itself not exercised (no API) |

## 0. Status update (same day)

**F1 and F2 are stopped, not fully fixed.** The booking-module role cannot touch the ledger, wallets or holds, and the API role cannot write a booking, so settlement cannot be done safely in one step without new privileges. The answer route now refuses first answers (`409 ANSWER_REQUIRES_SETTLEMENT`), the portal is read only, and ADR 0061 Amendment 4 records the decision and the open design choice. Re-enabling supplier answers needs the settlement path described there.

## 1. Verdict

The extranet is **secure and honest, and its safety checks are well built**. Tenant and organization scoping, permission gating, idempotency, compare-and-set and audit are all done properly. The weaknesses are not in security. They are in **business logic that two flows disagree about**, and in **half-built workflows**:

1. The supplier "answer" flow changes a booking's status but not the money or inventory the agent flow moves for the same booking (F1, F2).
2. The availability change-set workflow can be started by a supplier but has no staff review, no apply step and no screen (F3).
3. Several workflow rules in ADR 0061 that were stated as "required before launch" are not implemented (F4, F5, F6).

Do not enable `supplier.extranet.bookings.answer` for real suppliers until F1 and F2 are resolved.

## 2. Findings

Severity: **Critical** = money or stock can be wrong; **High** = a stated rule is missing or a workflow dead-ends; **Medium** = wrong or misleading behaviour with a workaround; **Low** = polish.

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | Critical | A supplier **confirming** a contracted booking sets `CONFIRMED` but never settles it. The agent flow (`BookingConfirmationService.confirm`) does five things in one transaction: moves inventory held to sold, marks the hold `CONFIRMED`, turns the wallet `HOLD` into a final `DEBIT`, writes the status change and queues the confirmation email. The supplier path calls only `transitionBooking`, whose finance step writes a `BookingFinanceEvent` row and, by its own comment, changes no ledger, wallet or balance. After a supplier confirm, the agent's later confirm hits `status === 'CONFIRMED'` and returns `alreadyConfirmed: true` **without settling**. Result: a confirmed booking with the agency never debited and stock still marked held, which the hold-expiry sweep can return to sale (oversell). | *code-verified:* `supplier-booking-answer.service.ts:48-52`, `booking-transition.ts` (finance branch), `booking-finance-events.ts:1-8` and `:37-44`, `booking-confirmation.service.ts:29-34` and `:57-78` |
| F2 | Critical | A supplier **rejecting** a `PENDING_SUPPLIER` booking runs `systemFail` (status `FAILED`). It releases neither the wallet reservation nor the inventory hold. `BookingReconciliationService` is the sweeper for stuck holds, and it classifies a booking no longer pending as `booking_not_pending: left alone`, so nothing ever returns the agency's reserved funds or the stock. `HOLD_RELEASED` is recorded only if an `ON_REQUEST_HOLD` event exists, which a direct reject from pending does not have. | *code-verified:* `supplier-booking-answer.ts:17-19`, `booking-finance-events.ts:49-54`, `booking-reconciliation.service.ts:15-20` |
| F3 | High | **Change sets dead-end.** A supplier can create, replace, submit and withdraw an availability change set through the API, but there is no staff queue, approve, reject or apply anywhere in `apps/api` or `apps/admin`, and no `supply.supplier-changes.review` permission exists. The runtime-role note says review columns "are not granted until the staff review step", which has not been built. There is also no supplier screen: the nav entry "Inventory submissions" renders the unavailable page. A submitted set can only be withdrawn. | *code-verified:* grep for `supplier-changes` and `SupplierChangeSet` finds only the supplier service, controller, module, role contract and one spec; `app/(portal)/inventory/page.tsx` is the 11-line unavailable stub |
| F4 | High | **No rate limit** on the supplier routes. ADR 0061 Amendment 2 says per-organization rate limiting on the answer route is "required before launch". The only throttling in the API is on login and password reset. The change-set `preview` route validates up to 90,000 characters against up to 2,000 plans on every call with no limit. | *code-verified:* `grep Throttle apps/api/src/supplier-extranet` is empty; the only app-wide guard is `CrossSiteRequestGuard` |
| F5 | High | **Supplier status is not checked on writes.** The organization guard accepts suppliers in `DRAFT` and `PENDING_REVIEW` as well as `ACTIVE`. That is right for reading hotels during onboarding, but the same guard fronts the answer and change-set write routes, so an organization still under review can answer bookings and submit availability. | *code-verified:* `supplier-organization.guard.ts:13` (`SELECTABLE_SUPPLIER_STATUSES`), used by every route |
| F6 | High | **No answer deadline or SLA.** A booking can wait in `PENDING_SUPPLIER` with no due time, no timer and no surfaced age. ADR 0061 defers this to "notifications (slice 7)", which does not exist. The portal shows neither booking age nor a count of bookings that need an answer on the dashboard. | *code-verified:* no deadline field in the bookings DTOs or pages; ADR 0061 Amendment 2 rule 8 |
| F7 | Medium | **Permissions are tenant-wide, not per organization.** `permissionKeys` reads the user's tenant roles, so a person in two supplier organizations has identical rights in both. A user cannot be read-only in one and an author in the other. | `supplier-extranet.service.ts:37-43` |
| F8 | Medium | **The portal makes a promise the platform does not keep.** The dashboard trust strip says "Nothing is published or booked without your answer". Contracted bookings are confirmed by the agent flow without any supplier answer (F1), so this statement is false for the main supplier type. This is the kind of claim constitution invariant 10 warns against. | `dashboard/page.tsx` trust strip; `booking-confirmation.service.ts` |
| F9 | Medium | **"Need your answer" counts only the current page.** The bookings list is newest-first with 25 rows per page, and the summary counts waiting bookings on that page only, so actionable bookings on page 2 or later are invisible in the summary. There is no default "awaiting answer" view and no ordering by arrival date. | `bookings/page.tsx:31-33`, `supplier-bookings.service.ts` ordering |
| F10 | Medium | **A supplier reject carries no reason code.** Reject needs only a 10-character free-text reason and moves money-relevant state immediately (option A in ADR 0061). There is no reason list for reporting, no cap on rejects per period, and no flag for a supplier whose reject rate is unusual. | `supplier-booking-answer.ts:26-31` |
| F11 | Medium | **Confirm does not require the hotel confirmation number.** Only the supplier's own reference is required; `hotelConfirmationNo` is optional. Hotels and agencies usually rely on the hotel's number. | `supplier-booking-answer.ts:27`, `BookingAnswerForm.tsx` |
| F12 | Medium | **Success message reads wrongly on a reject.** `systemFail` moves the booking to `FAILED`, and the form tells the supplier "The booking is now failed." A supplier who declined a booking sees wording about a failure. | `BookingAnswerForm.tsx:14-16`; `booking-lifecycle.ts:83` |
| F13 | Medium | **"Not mapped" is mislabelled.** The Properties summary counts every hotel not `MAPPED` as "Not mapped", which includes `PENDING` (waiting for review), not unmapped. | `hotels/page.tsx:25-27` |
| F14 | Medium | **Contracts and hotels are read-only with no way to ask for a change.** A supplier who finds a wrong term or a missing hotel has no in-portal route; the only path is "ask your account manager". Support, Help, Team and Profile are all unavailable pages. | `nav-config.ts`, the 11-line stubs |
| F15 | Low | **Each request runs the permission query twice.** The permission guard and the service both call `requirePermission`, and each loads every role and permission of the user. Defence in depth is intended, but the cost is a heavy join per request. | `supplier-permission.guard.ts`, `supplier-extranet.service.ts:37-43` |
| F16 | Low | **Room draft audit uses `auditEvent.create`** while the change-set and answer paths deliberately use `createMany` so the write role does not need read-back. Check this is allowed under the runtime role on the supplier path. | `supplier-extranet.service.ts` `saveRoomDraft` |
| F17 | Low | Duplicated hotel parsing (`listHotels`, `getHotel`) and a 352-line API client with no shared parser. Carried over from the 2026-10-19 audit (F8). | `lib/supplier-api.ts` |
| F18 | Low | Cookies are always `secure: true`. This works on `localhost` in current browsers but not on plain-HTTP preview hosts. | `lib/actions.ts` |

## 3. What is strong (keep)

| Area | Evidence |
|---|---|
| Tenant identity from the server only | portal reads the tenant from `/auth/me`, refuses ambiguity; header is only a selector among the caller's own active memberships |
| Fail-closed permissions | `SupplierPermissionGuard` refuses any route that forgot to declare a permission |
| Organization scoping | every query filters tenant and supplier inside `withSupplier`; out-of-scope ids are 404, never 403 |
| Idempotency and concurrency | answer and change-set writes need an `Idempotency-Key`; replay returns the stored result; a different body under the same key is 409; compare-and-set on status and version; row locks |
| Audit | every write path records an event; payloads hold ids and counts, not free text or guest data |
| Money | integer minor units end to end; `bigint` arithmetic in the net summary; missing is "Not recorded", never zero; a mismatch hides the total |
| Supplier-visible data minimality | column-level database grants keep sell price, markup and agency identity out of reach |
| Honesty of unavailable modules | placeholder routes say so and write nothing |
| Change-set design | frozen cells after submit, append-only events, supplier-scoped plan allow-list, pooled plans refused |

## 4. Workflow map: what a supplier can and cannot do today

| Stage | Supplier capability | State |
|---|---|---|
| Sign in, reset password, choose organization | yes | live |
| See mapped hotels and rooms, keep a private note | yes | live, read plus a note |
| See contracts and rate plans (no amounts) | yes | live, read only |
| See bookings, filter, open detail | yes | live |
| Confirm, put on request or reject a booking | yes | live, **but F1, F2, F5, F6, F10, F11** |
| Submit availability or stop-sale changes | API only | **no screen, no staff review, no apply (F3)** |
| Change rates, promotions, restrictions, allotments | no | unavailable |
| Vouchers, invoices, statements, reports | no | unavailable |
| Team and role management, supplier profile, support | no | unavailable |
| Notifications and SLA timers | no | not built |

## 5. Recommendations

**Before any real supplier gets `bookings.answer` (blocks launch)**
1. Decide who owns settlement when a supplier answers a contracted booking. Two safe options: (a) route supplier answers through the same transactional service as the agent flow so inventory and wallet move with the status; or (b) refuse a supplier answer for contracted bookings whose hold is still `PROCESSING`, and let the agent flow own `PENDING_SUPPLIER` to `CONFIRMED`. Add an e2e that asserts wallet, hold and inventory counters after each of confirm, on request, and reject. Write an ADR amendment recording the choice. (F1, F2, F8)
2. Add per-organization rate limits on `answer`, `preview` and `create`. (F4)
3. Require `ACTIVE` supplier status on every write route; keep `DRAFT` and `PENDING_REVIEW` read-only. (F5)

**Next slice**
4. Build the staff side of change sets (queue, approve or reject with reason, apply through the existing calendar editor, permission `supply.supplier-changes.review`) before building the supplier screen, so submitted sets cannot strand. (F3)
5. Show booking age and a real "awaiting your answer" count on the dashboard, a default awaiting-answer view, and an answer deadline with escalation to fBeds operators. (F6, F9)
6. Add reject reason codes and a reject-rate report; require the hotel confirmation number on confirm or record why it was waived. (F10, F11)

**Cleanups**
7. Reword the dashboard trust strip until F1 is resolved; fix the reject success message; rename the "Not mapped" tile. (F8, F12, F13)
8. Move permissions to the supplier membership level so rights can differ per organization. Needs an ADR and a migration. (F7)
9. Run `pnpm check:architecture`, the full test suite and the supplier e2e on a host with PostgreSQL and Node 24 before the next release; none of those ran here.

## 6. Limits of this audit

- Findings F1 and F2 come from reading the answer path and the agent confirmation path side by side. They have not been reproduced against a database. The existing answer e2e (SA-01 to SA-12) checks status, audit and the finance fact, and does not assert wallet, hold or inventory state, which is why the gap would not have been caught.
- No performance, load, accessibility or penetration testing was done.
- The prior audits (`apps/supplier/CTO_AUDIT_REPORT.md`, `docs/supplier-extranet-cto-audit-2026-10-12.md`, `docs/audits/2026-10-22-cto-bug-report.md`) were consulted but not re-verified line by line.
