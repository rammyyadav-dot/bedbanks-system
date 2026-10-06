# FBEDS Admin — Booking Module Workflow

_Source spec for Claude Code. Keep this file in the repo at docs/booking-module-spec.md._

## Purpose and scope

The booking module is the operations desk for every reservation across all tenants and suppliers: it must let an ops agent find any booking in seconds, see what needs action now, and move each booking safely to a final state. Today's All Bookings screen is a read-only table with 4 statuses; this spec turns it into a working queue.

**What we keep from each reference screen**

| Reference | Keep | Why |
| --- | --- | --- |
| FBEDS All Bookings (current) | Tenant, Agent, Supplier and multi-currency Amount columns; global search; status pills | Bedbank is multi-tenant and multi-supplier, so these are the axes ops filters on most |
| Booking Enquiries (OTA reference) | Quick-search chips, Supplier Ref column, "Only missing supplier ref" toggle, Urgent badge, List/Kanban toggle, Excel/CSV and Print, pending counter in the header, Guests (AD/C), Nights, Room type + board basis | These turn a list into a work queue and cut ops clicks |

**In scope:** booking list, detail, status lifecycle, supplier confirmation, amendments, cancellations, no-shows, urgency/SLA, vouchers, notifications, finance hooks, permissions, audit.

**Out of scope here:** agent-portal search and checkout UI, rate loading, contract management (covered by the Rates and Contracts modules; the booking module only reads their snapshot).

## Booking lifecycle

Every booking moves through ten statuses with a fixed set of allowed next moves; the API rejects any other transition, so the UI and Kanban can never put a booking in an impossible state.

| From | Allowed next statuses |
| --- | --- |
| (new) | Pending supplier |
| Pending supplier | Confirmed, On request, Failed |
| On request | Confirmed, Rejected |
| Confirmed | Amend requested, Cancel requested, Checked out |
| Amend requested | Confirmed (approved or rejected — booking returns to Confirmed) |
| Cancel requested | Cancelled |
| Checked out | No-show, Closed |
| No-show, Cancelled, Rejected, Failed | Closed (after dispute window) |

On request, Pending supplier, Amend requested and Cancel requested are the ops queue states and each carries an SLA timer. A Failed booking is never edited back to life: recovery creates a new booking linked to the old one. Supplier status (the supplier's own answer) is stored separately from booking status, which replaces today's four-value status pill.

## Booking list screen (All Bookings)

The list opens on the **Needs action** quick search, not on all bookings, so ops lands on work rather than history. Header shows title, a live counter chip ("7 Pending · 2 Failed"), List / Kanban toggle and refresh.

**Filter bar** (applied together, kept in the URL so views can be shared):

| Filter | Type | Notes |
| --- | --- | --- |
| Reference | Text | Matches FBEDS ref (FB…), supplier ref, hotel confirmation no., agent's own ref |
| Guest name | Text | Lead guest or any guest |
| Tenant | Multi-select | Hidden for tenant-scoped users |
| Agent | Search select | Filtered by chosen tenant |
| Supplier | Multi-select | Includes Direct contract |
| Hotel / City / Country | Search select | |
| Status | Multi-select | Booking status and supplier status separately |
| Date type + range | Select + range | Booking date, Check-in, Check-out, Cancellation deadline |
| Payment | Select | Credit, Prepaid, Pay at hotel; Paid / Unpaid / Overdue |
| Toggles | Switch | Only missing supplier ref · Only urgent · Only non-refundable · Only amended |

**Quick-search chips** (one click, combinable with filters): Needs action · Latest bookings · Check-in next 7 days · Missing supplier ref · Deadline in 48h · Failed · Latest cancelled · On request · Unpaid · No-show candidates.

**Columns** (default set; user can show/hide and reorder, saved per user):

| Column | Content |
| --- | --- |
| Booking # | FBEDS ref, link to detail; Urgent / NR / Amended badges below |
| Status | Coloured dot + label; supplier status in small text if it differs |
| Tenant / Agent | Two lines |
| Supplier / Supplier ref | Ref shown as "Missing" in red when empty after confirmation |
| Lead guest | Name + guest count (2 AD · 1 C) |
| Hotel / Room | Hotel, then room type and board basis in small text |
| Stay | Check-in → check-out, nights |
| Booked on | Date and time, tenant timezone |
| Deadline | Free-cancellation deadline; red under 48h |
| Sell / Net | Sell amount in booking currency; net and margin on hover (admin only) |
| Actions | View, quick status, more menu |

**Kanban view:** one column per status (On request, Pending supplier, Confirmed, Amend requested, Cancel requested, Failed). Cards show ref, hotel, guest, check-in, amount and urgency. Dragging a card opens the same transition dialog as the detail page; only legal moves are allowed.

**Bulk actions** on selected rows: export, assign to agent, add tag, resend voucher, retry supplier sync. No bulk cancel.

**Export and print:** Excel/CSV of the current filtered set (max 10,000 rows, async above 1,000 with email link); Print renders a clean A4 list. Every export is written to the audit log.

**Footer:** result count, page size (25/50/100), pagination. Empty state explains which filter removed everything and offers "Clear filters".

## Booking detail screen

One page per booking at `/bookings/[ref]`, with a sticky header and tabs so ops never leave the page to act.

**Sticky header:** FBEDS ref, status pill, supplier status, badges (Urgent, Non-refundable, Amended, Test), tenant and agent, and the action buttons allowed for the current status only. A countdown shows time to the next deadline (supplier SLA or cancellation deadline).

**Tabs**

1. **Summary** — hotel, address, room type, board basis, stay dates, nights, rooms × occupancy, lead guest and all guests, special requests, agent's own reference.
1. **Pricing** — sell price, net cost, margin, markup rule applied, taxes and fees, currency and FX rate frozen at booking, cancellation policy snapshot with each penalty step and date.
1. **Supplier** — supplier, supplier ref, hotel confirmation number, rate key, raw request and response payloads (admin only), sync history and retry button.
1. **Payments** — payment mode, credit used against tenant limit, invoices, receipts, refunds, outstanding balance.
1. **Documents** — voucher, invoice, credit note, cancellation note; each with resend and download.
1. **Messages** — email and WhatsApp log to agent and hotel, internal notes (never visible to agent), @mentions to teammates.
1. **Timeline** — every status change, edit, export, view of sensitive data, with user, time and before/after values.

**Action buttons by status** (anything not listed is hidden, not disabled):

| Status | Actions available |
| --- | --- |
| On request | Confirm with supplier ref, Reject, Offer alternative, Assign |
| Pending supplier | Retry, Mark confirmed manually, Mark failed, Assign |
| Confirmed | Add/edit supplier ref, Amend, Cancel, Resend voucher, Reconfirm with hotel |
| Amend requested | Approve amendment, Reject amendment |
| Cancel requested | Confirm cancellation, Retry supplier cancel |
| Failed | Rebook same hotel, Rebook alternative, Close as failed |
| Checked out / No-show | Mark no-show, Raise invoice adjustment |
| Cancelled / Rejected / Closed | Resend cancellation note, View only |

## Core workflows

Each workflow below ends in a defined status; nothing is left in an unnamed state.

### A. Intake (new booking)

1. Booking arrives from one of three channels: agent portal checkout, tenant API (XML/JSON), or manual entry by ops (offline/phone booking).
1. System runs a pre-book check with the supplier: price and availability re-check against the rate key.
    - Price up beyond tolerance (e.g. 2%) → return price-change prompt to agent; no booking created.
    - Sold out → return unavailable; no booking created.
1. Credit or payment check: tenant credit limit, or prepayment captured for prepaid tenants. Fail → booking not created, agent told why.
1. Booking record created with FBEDS ref (format `FB` + YYMMDD + 6-digit sequence, as today), status **Pending supplier**, and frozen snapshots of rate, cancellation policy, FX and markup.
1. Book request sent to supplier through a queue (SQS), never inline, so a slow supplier does not hang the agent.

### B. Supplier confirmation

1. Supplier returns confirmed + supplier ref → status **Confirmed**, voucher generated, agent email sent, credit consumed.
1. Supplier returns on-request → status **On request**, booking enters the ops queue with an SLA timer.
1. Timeout or error → automatic retries (3 attempts, 30s / 2 min / 5 min). Still no answer → **Failed** and alert to ops. Before marking failed, the system checks the supplier for a booking by our ref to avoid a ghost booking.
1. Confirmed without supplier ref or hotel confirmation number → stays **Confirmed** but flagged "Missing supplier ref"; appears in that quick search until filled.

### C. On request handling (ops)

1. Ops picks the booking from Needs action (or it is auto-assigned by tenant or region).
1. Ops contacts supplier or hotel, then chooses: **Confirm** (enter supplier ref and hotel conf. no. — both mandatory), **Reject** (reason mandatory), or **Offer alternative** (new hotel/room/price sent to agent for acceptance).
1. Alternative accepted by agent → original closed as Rejected, new booking created and linked. Declined or no reply within the offer window → original Rejected.

### D. Failed booking recovery

1. Ops sees the failure reason (supplier error code and message in plain words).
1. Options: rebook same hotel via another supplier, rebook alternative hotel, or close as failed.
1. Any held credit or prepayment is released or refunded automatically when closed.

### E. Amendment

1. Agent or ops requests a change: guest names, dates, room type, occupancy, special requests.
1. Name change and special requests → sent to supplier directly; dates, room or occupancy → treated as re-price: new rate shown with difference before submit.
1. Status **Amend requested** until supplier confirms. Approved → booking updated, version number +1, new voucher, difference invoiced or credited. Rejected → original booking stays as it was.

### F. Cancellation

1. Request from agent or ops shows the penalty from the frozen policy snapshot, in booking currency, before the user confirms.
1. Status **Cancel requested**; cancel call sent to supplier.
1. Supplier confirms → **Cancelled**, cancellation note issued, penalty invoiced, remainder credited or refunded.
1. Supplier cancel fails → stays Cancel requested, flagged Urgent; ops cancels manually and records the supplier cancellation ref.
1. Non-refundable bookings need a second confirmation and an admin role to cancel.

### G. Stay completion and no-show

1. Day after check-out, Confirmed bookings auto-move to **Checked out** (nightly job).
1. Hotel reports no-show → ops marks **No-show** within 7 days of check-in; no-show penalty applied per policy.
1. After the dispute window (e.g. 30 days), booking moves to **Closed** and is locked for edits except finance adjustments.

## Urgency, SLAs and the work queue

The Urgent badge is computed by rules, never set by hand, so it always means the same thing. A booking is Urgent when any rule below is true; the badge clears itself when the rule stops being true.

| Rule | Trigger | SLA to resolve | Escalation |
| --- | --- | --- | --- |
| On request ageing | On request for more than 2 h | 4 h | Ops lead notified at 4 h |
| Close check-in | Not Confirmed and check-in within 72 h | 2 h | Ops lead + tenant account manager |
| Missing supplier ref | Confirmed, no supplier ref 24 h after confirmation | 24 h | Ops lead |
| Failed booking | Any Failed not closed | 1 h | Ops lead |
| Stuck cancel | Cancel requested for more than 1 h | 2 h | Ops lead + finance |
| Deadline risk | Agent asked to cancel within 24 h of deadline | Before deadline | Ops lead |

SLA values are defaults; each tenant contract can override them in settings.

**Needs action** = all Urgent + On request + Pending supplier over 15 min + Amend requested + Cancel requested + Failed, sorted by nearest SLA breach first.

**Assignment:** bookings can be assigned to one ops user. Auto-assign by tenant or destination region is optional. Assigned user and time-in-queue show on the row and the Kanban card.

## Finance, vouchers and notifications

Every status change that moves money writes a ledger entry; the booking module never edits balances directly, it emits events the Finance module books.

| Event | Finance entry | Document | Notified |
| --- | --- | --- | --- |
| Confirmed | Credit consumed or prepayment captured; supplier payable created | Voucher, invoice | Agent (email), hotel (optional reconfirmation) |
| On request | Credit held, not consumed | — | Agent: "on request" email; ops in-app |
| Rejected / Failed closed | Hold released or refund raised | — | Agent |
| Amendment approved | Difference invoiced or credited | New voucher, revised invoice | Agent, hotel |
| Cancelled | Penalty invoiced; remainder credited or refunded; supplier payable reduced | Cancellation note, credit note | Agent, hotel |
| No-show | Penalty per policy | Adjustment invoice | Agent |

**Voucher** carries tenant branding (white-label), FBEDS ref, agent ref, hotel confirmation number, guest names, room, board, dates, inclusions, emergency contact. It never shows net rate or supplier name.

**Notification channels:** email by default; WhatsApp and webhook per tenant setting. Tenant API clients receive a webhook for every status change.

**Currency:** sell amount stays in the booking currency (USD, EUR, GBP, AED as in today's screen). Reports convert using the FX rate frozen at booking, never today's rate.

## Roles and permissions

Permissions plug into the existing Roles & Permissions screen as named actions (e.g. `booking.cancel.nonrefundable`), so a role is just a set of these.

| Action | Super admin | Ops lead | Ops agent | Finance | Tenant admin | Read-only |
| --- | --- | --- | --- | --- | --- | --- |
| View all tenants' bookings | Yes | Yes | Assigned regions | Yes | Own tenant | Yes |
| See net rate and margin | Yes | Yes | No | Yes | No | No |
| See raw supplier payloads | Yes | Yes | No | No | No | No |
| Confirm / reject on request | Yes | Yes | Yes | No | No | No |
| Edit supplier ref | Yes | Yes | Yes | No | No | No |
| Amend booking | Yes | Yes | Yes | No | Request only | No |
| Cancel refundable | Yes | Yes | Yes | No | Request only | No |
| Cancel non-refundable / waive penalty | Yes | Yes | No | Approve waiver | No | No |
| Manual booking entry | Yes | Yes | Yes | No | No | No |
| Export | Yes | Yes | Yes | Yes | Own tenant | No |
| Change SLA rules | Yes | Yes | No | No | No | No |

Tenant scoping is enforced in the API query layer (tenant ID on every query), not only hidden in the UI.

## Data model

Six tables carry the module; snapshots are stored as JSON so later rate or policy edits never change a past booking.

| Table | Key fields |
| --- | --- |
| `booking` | id, ref (unique), tenant_id, agent_id, channel (portal/api/manual), status, supplier_status, supplier_id, supplier_ref, hotel_conf_no, agent_ref, hotel_id, check_in, check_out, nights, currency, sell_amount, net_amount, markup_amount, fx_rate, payment_mode, payment_status, is_refundable, cancel_deadline, is_urgent (computed), assigned_to, version, created_at, updated_at |
| `booking_room` | booking_id, room_type, board_basis, adults, children, child_ages, rate_key, sell, net |
| `booking_guest` | booking_id, room_id, title, first_name, last_name, is_lead, type (AD/CH) |
| `booking_snapshot` | booking_id, version, rate_json, cancel_policy_json, markup_rule_json |
| `booking_event` | booking_id, from_status, to_status, actor_id, actor_type (user/system/supplier), reason, payload_json, created_at |
| `supplier_call` | booking_id, action (prebook/book/amend/cancel/status), request_json, response_json, http_status, duration_ms, attempt, created_at |

Indexes: (tenant_id, status, check_in), (supplier_ref), (ref), (cancel_deadline) for the quick searches. Guest names and contact details are personal data: mask in lists for read-only roles and log every unmasked view.

## Edge cases and build phases

**Edge cases the workflow must handle**

- Duplicate booking: same agent, hotel, dates and lead guest within 10 minutes → warn before submit, flag on both bookings.
- Ghost booking: supplier timed out but actually booked → status check by our ref before marking Failed; nightly reconciliation against supplier reports.
- Supplier cancels on its side → inbound webhook or reconciliation sets **Cancel requested** with reason "Supplier-initiated", Urgent, ops must rebook or inform agent.
- Price changes after confirmation → ignored; frozen snapshot rules.
- Deadline passes while a cancel request is pending → penalty is based on the time the request was made, not when the supplier answered.
- Tenant suspended → existing bookings stay serviceable; new bookings blocked.
- Time zones: deadlines stored in UTC, displayed in hotel local time with the zone label.

**Build phases**

| Phase | Delivers | Done when |
| --- | --- | --- |
| 1. Read-only list + detail | Real DB-backed list with filters, quick searches, columns, detail tabs (Summary, Pricing, Timeline) | Any booking found by any reference in under 2 s; tenant users see only their tenant |
| 2. Lifecycle engine | Status machine, transition dialogs, booking_event log, manual booking entry | Illegal transitions rejected by API; every change visible in Timeline |
| 3. Supplier integration | Queue-based book/cancel/status calls, retries, supplier_call log, missing-ref flag | Timeout test produces no ghost booking; retry works from detail page |
| 4. Queue and SLA | Urgent rules, Needs action view, Kanban, assignment, escalation alerts | Each rule fires and clears in a test case |
| 5. Money and documents | Finance events, vouchers, invoices, credit notes, notifications, webhooks | Cancel with penalty produces correct invoice and credit note |
| 6. Ops polish | Bulk actions, saved views, async export, print, reconciliation job | Daily reconciliation report runs unattended |

Open questions: final SLA defaults per tenant tier; whether hotel reconfirmation emails go out automatically or on ops click; dispute window length before Closed.

## Decisions (2026-10-06)

1. **Build location.** Monorepo, API plus Admin, following `CLAUDE.md`. Where this spec's data model overlaps existing models (`Booking`, `Cancellation`, `SupplierMutation`, the booking transaction state machine), extend and map rather than duplicate. The six tables above describe the target shape, not mandatory new tables. Record the mapping in the gap table and the ADR.
2. **Closed is a lock, not an eleventh status.** Keep the ten statuses. "Closed" is a `closedAt` timestamp plus edit lock, so the last real status (Cancelled, No-show, Checked out, Rejected, Failed) stays visible for reporting. Wherever the transition table says "→ Closed", read it as "set closedAt". The action-button row "Cancelled / Rejected / Closed" means any booking with closedAt set.
3. **Existing four-value `BookingStatus`.** Migrate to the ten statuses with an explicit old → new mapping in the migration and ADR. Keep supplier status as a separate field.
4. **Booking enablement.** Keep `BOOKING_ENABLED=false`, and keep Agent booking routes returning `booking_unavailable`. The Admin module manages and services existing bookings. Admin manual booking entry (Phase 2) goes behind a separate flag, `ADMIN_MANUAL_BOOKING_ENABLED`. That flag defaults to false and is enabled only in dev/staging against the mock supplier adapter until real suppliers are live.
