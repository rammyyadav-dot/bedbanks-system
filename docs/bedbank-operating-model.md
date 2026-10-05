# fBeds bedbank operating model: workflow, functioning, business rules and logic

Audience: CTO, product, finance, operations, contracting and engineering. Purpose: one reference for how fBeds works as a **B2B hotel bedbank**, from signing a hotel to settling a booking, with the business rules the platform enforces, what is built, and what a production bedbank still needs. It is grounded in the code and ADRs in this repository (cited inline). Where the industry norm differs from what is built, it says so and does not present the gap as a capability.

Status key: **Built** is implemented and tested on `main`. **Built, off** is implemented but disabled (booking is off by default). **Rule only** is a stated rule not yet enforced by code. **Not built** has a stated dependency. **Proposed** is a draft decision awaiting the owner. Nothing here enables booking, payment or a live supplier connection; those stay separate, gated changes.

Companion documents: `docs/admin-hotel-module-blueprint.md` (the hotel module in depth), `docs/admin-hotel-operations.md`, ADRs 0003 to 0027.

---

## 1. What the business is

A bedbank buys hotel inventory at **net (wholesale) rates** from hotels and other suppliers and resells it, with a margin, to **travel agents and tour operators** (B2B). It never sells to the public. Its value is: (1) breadth of contracted and connected supply, (2) a normalised catalogue so one hotel appears once however many suppliers sell it, (3) accurate, bookable prices and availability, (4) fast, reliable booking, and (5) trusted money handling (credit, invoicing, settlement).

Revenue is the spread between the net cost and the sell price, plus any fees. The platform's job is to make that spread **correct, auditable and never wrong in the agent's favour by accident**.

fBeds specifics:
- **Multi-tenant.** Each bedbank company is a tenant, isolated by forced row-level security (ADR 0003). Tenant identity comes only from the authenticated session.
- **Dubai MVP first**, up to about 100 hotels, contracted (direct) supply; supplier connectors are a defined boundary with none live.
- **Money is integer minor units plus ISO-4217 currency**, never floating point, in every pricing, finance and booking path.

## 2. Actors

| Actor | What they do | Where |
|---|---|---|
| Platform operator | Runs the system, tenants, release safety | Platform scope |
| Tenant staff (the bedbank) | Contracting, supply, mapping, rates, commercial, finance, operations, support | Admin app, permission-gated (ADR 0015) |
| Agency | A travel agent company that buys; has members, a status and an optional credit limit | Agents & Clients module (ADR 0019, 0020, 0024) |
| Agent user | A member of an agency who searches and books | Agent app |
| Supplier / hotelier | Provides rates and inventory; may use the extranet | Supplier app (ADR 0011) |
| Approver | A second person for sensitive changes (maker-checker) | ADR 0016 |

Two people are required for: publishing a hotel (0022), activating a markup (0018), suspending or reinstating an agency (0020), changing a credit limit (0024), and resolving reconciliation (0017).

## 3. The value chain, end to end

```
 CONTRACT -> LOAD -> MAP -> PRICE -> PUBLISH -> DISTRIBUTE -> SEARCH -> RECHECK -> HOLD -> PREBOOK -> CONFIRM -> DOCUMENTS
    |          |       |       |         |            |           |         |         |        |         |          |
 supplier   rates &  canonical markup   hotel      who may     only      live      atomic   supplier  one DB    voucher,
 + terms    allotment  hotel/   rules   catalogue  buy what    bookable  re-price  inventory  prebook   transaction invoice
            per night  room     (NET)   eligible   & credit    stays     + check   reserve  (off)     (off)      (once)
                                                                                                    -> AMEND/CANCEL -> SETTLE -> RECONCILE -> REPORT
```

Every arrow is a point where the platform must fail closed: if a fact is missing or ambiguous, the stay is **not offered**, the action is **refused**, and the reason is **visible**.

## 4. Domain rules

### 4.1 Supply and contracting
- A **supplier** (type HOTEL_DIRECT, DMC, and so on) is ACTIVE or not; a non-active supplier sells nothing.
- A **contract** belongs to a supplier and a supplier hotel mapping, has validity dates, a settlement currency and a status (ACTIVE to sell). Only ACTIVE contracts inside their validity window can sell a night. Contract create and edit need `supply.contracts.manage`. Contract approval (`contract.approve`) and termination are **planned, not built**.
- **Rate plans** hang from a contract and a room type, with a board basis (for example room only, bed and breakfast), occupancy, currency, minimum stay, maximum stay, release days and status.
- **Rule only / Not built:** contract documents and versions, allotment agreements with release back to the hotel, commission-based and static versus dynamic contract types, supplier-specific payment terms.

### 4.2 Content and mapping (one canonical hotel)
- The **canonical hotel** is the single identity (ADR 0009, 0021). Supplier hotels and rooms are mapped to it; the hotel and room mapping must both be MAPPED before anything sells. Mappings are never auto-approved, decisions need a reason, conflicts are coded 409s, and history is kept (ADR 0004).
- A hotel is **published** (catalogue-eligible) only after the 12 requirements and a second approver (ADR 0021, 0022). Publishing does not make it sellable.
- Images, rooms, amenities, policies and private contacts are managed in the Admin hotel module; Agents see the primary image of published hotels (ADR 0027).
- **Not built:** automatic mapping suggestions, supplier content import and enrichment, geo-clustering, duplicate detection beyond identifier uniqueness.

### 4.3 Rates and inventory
- A **daily rate** is per rate plan, night and occupancy, with an `amountMinor`, currency and a mandatory **basis**: `SELL` (agent-facing, explicitly approved) or `NET` (supplier cost, needs markup). An unclassified legacy row **fails closed** with `RATE_AMOUNT_BASIS_UNVERIFIED` (`docs/authoritative-rate-amount-semantics.md`).
- **Daily availability** per plan and night: `allotment`, `sold`, `held`, `stopSell`, `minStay`, `closedToArrival`, `closedToDeparture`. Free rooms = allotment minus sold minus held.
- Rules **enforced per night** by the evaluator: stop-sell, allotment remaining, minimum stay, closed to arrival, plan maximum stay, release days, contract validity. Rules **recorded but not enforced**: closed to departure, sales markets, nationalities (shown as "recorded, not applied").
- Missing data is never zero: no rate or no availability row means the night is **not sellable**, with a stated reason.
- Rates and inventory change through Quick Update (previewed, atomic, audited, idempotent, concurrency-checked; ADR 0021).
- **Not built:** allotment pools shared across plans, lock dates (proposal ADR 0026), seasonal and dynamic rate generation, stop-sell rules by market, automatic inventory feeds.

### 4.4 Pricing
- **SELL** rates are sold as stored. **NET** rates are sold only when a markup rule applies (ADR 0018).
- A **markup rule** is a percentage in integer basis points (0 to 10,000) on NET rates, scoped to hotel, supplier or tenant default. The most specific active rule whose dates contain the night wins. Maths is exact integer: `(net * bp + 5000) / 10000`, round half up, **per night**, summed, then times rooms. Rules are immutable; only status moves; activation is maker-checker; a change between search and recheck returns `price_changed`, never a silent new price.
- Agent search, recheck, hold and Admin readiness all use **one evaluator**, so the price an Agent sees is the price Admin explains.
- **Rule only / Not built:** taxes and fees as separate lines, per-agency or per-market price lists, promotions and discounts, rounding by currency exponent beyond the stored minor unit, currency conversion (FX), commission-based pricing, rate parity checks, dynamic repricing.

### 4.5 Distribution (who may buy what)
- An **agency** is ACTIVE, INACTIVE (directory only, blocks nothing) or SUSPENDED (cannot search, recheck, hold, prebook or book; existing bookings can still be read and cancelled; ADR 0020).
- **Distribution restrictions** can hide a hotel or supplier from an agency; search honours them.
- A **credit limit** caps the holds an agency can place (ADR 0024): integer minor units, one currency, a hold over the limit is refused with no override, fail closed if the limit cannot be read, changes need two people.
- **Not built:** markets and channels (country, nationality, channel-specific rates), per-agent commercial profiles, sub-agent hierarchies, API (XML or JSON) distribution to third parties.

### 4.6 Search
- Input: canonical destination (city or hotel; free text is not a destination), dates, rooms with per-room adults and children (ages), nationality, selling currency, filters (stars, board, refundable, price range, property type), pagination.
- Output: only hotels that pass **every** gate for **every** night of the stay: published, ACTIVE supplier and contract, MAPPED hotel and room, ACTIVE plan, rate present for the occupancy and currency, availability, no stop-sell, stay rules. The hotel's offer is the cheapest valid supplier; the result carries a search id, offer ids and expiry.
- Contracted inventory is **not cached**, so stop-sell and rate edits are visible on the next search. Supplier failures are **observable** (`provider_unavailable`), never turned into demo, stale or zero-priced inventory.
- Per-room occupancy is kept; a flattened mismatch is rejected.

### 4.7 Recheck, hold and prebook (price and inventory integrity)
1. **Recheck** (`booking.prebook`): re-price and re-check the offer within five seconds against current data. A changed currency or amount returns `price_changed` and **allocates nothing**.
2. **Hold:** the client sends only the expected price and an idempotency key. In one transaction the platform checks the agency credit limit, then reserves `held` on **every night** (guarded so it never exceeds allotment). TTL is the shorter of the offer expiry and 15 minutes. Same key returns the same hold.
3. **Release or expiry:** an agent can release a HELD hold; an expiry sweeper releases expired holds (disabled unless explicitly enabled with its own restricted credential; ADR 0005).
4. **Prebook** (**Built, off**): persist a PENDING booking, claim the hold (HELD to PROCESSING), reserve funds, call the supplier prebook, record a durable marker; any failure compensates.
- Outcomes are explicit: `held`, `price_changed`, `unavailable`, `offer_expired`, `mapping_invalid`, `provider_unavailable`, `rejected` (`docs/supplier-recheck-hold-boundary.md`).

### 4.8 Booking confirmation (**Built, off**; `BOOKING_ENABLED` unset means audited 503)
- **Confirm** is one database transaction: lock booking, hold and wallet; require the prebook marker, a PROCESSING hold and a matching HOLD ledger entry; move `held` to `sold` on every night; hold to CONFIRMED; post `RELEASE` and `DEBIT` (net balance unchanged, history shows reservation became a charge); booking to CONFIRMED; audit. All or nothing and idempotent (ADR 0006).
- Interrupted attempts (PROCESSING holds that never finished) are resolved by an operator reconciliation action that is permission-guarded and, in the approval flow, maker-checker (ADR 0017).
- **Documents:** voucher (CONFIRMED booking), invoice (charged booking), credit note (CANCELLED booking), each issued **once**, content frozen, edits blocked by the database.
- **Not built:** supplier-side confirmation for non-contracted suppliers, confirmation numbers from supplier, notifications (email), special requests, booking amendments.

### 4.9 Cancellation (**Built, off** for contracted bookings)
- Only a CONFIRMED booking before the stay starts can be cancelled. The contract's cancellation rules (days before check-in, penalty as percent or fixed amount) are evaluated in the **hotel's time zone**; the result is an integer penalty and refund. **Fail closed** (409, nothing changed) when the policy is missing, ambiguous or not evaluable, with `manual_review_required` as an explicit outcome.
- In one transaction: sold inventory returns, the refund is posted to the ledger, the booking is CANCELLED, audit is written. The penalty is the part of the original debit not refunded. A cancellation quote can be read first.
- **Not built:** amendments and date changes, no-show handling, partial cancellation by room, supplier-side cancellation calls, penalties above the booking value, non-refundable promotions.

### 4.10 Finance
- A **wallet** is per tenant and currency. The **ledger** is append-only with types CREDIT, DEBIT, HOLD, RELEASE, REFUND; balances derive from it. A hold reserves funds; confirmation converts the reservation into a debit; cancellation posts a refund.
- Agencies carry a **credit limit** over holds (above). There is **no wallet top-up or payment gateway** in the code: funding a wallet and collecting money are **not built**.
- **Not built:** per-agency wallets and statements, deposit and payment links, supplier payables and settlement runs, supplier invoice matching, commissions and VAT or tax handling, multi-currency conversion and FX gain or loss, refund approval workflows (`refund.approve` and `adjustment.approve` are planned), month-end close, accounting export.

### 4.11 Reconciliation and exceptions
- Admin shows holds, bookings, ledger, audit and an exceptions centre (stuck holds, failed prebooks, mapping problems, sellability blockers). Stale PROCESSING holds are resolved through the reconciliation action.
- **Not built:** automated supplier-versus-platform reconciliation (no live supplier), daily margin and variance reports.

### 4.12 Supplier connectors
- A registry stores connector definitions with **encrypted credentials or secret references only**; raw supplier payloads, tokens and guest data are never logged (ADR and `docs/connector-registry-foundation.md`). Provider-specific types stay in the connector package and map to canonical domain types at the boundary.
- Failure classes (authentication, timeout, transport, malformed) are classified server-side and shown to Agents as the sanitised `provider_unavailable`.
- **No live connector exists.** A connector that **writes rates** is also the natural home for lock dates (ADR 0026).

### 4.13 Governance, security and audit
- **RBAC catalogue** with action classes S0 to S3; approval-only keys ride on the permission they refine; the server decides, buttons only mirror it (ADR 0015).
- **Audit:** every privileged or financial mutation writes an immutable event with actor, server request id, outcome and field names, never values such as contacts, descriptions, credentials or guest data.
- **Tenant isolation:** forced RLS on every tenant table; runtime role is least-privilege; an unreadable table is reported as unavailable, never empty.
- **Idempotency** on booking, cancellation, wallet, payment and webhook mutations.

## 5. State machines

| Object | States and moves |
|---|---|
| Hotel profile | DRAFT, INCOMPLETE, COMPLETE, SUSPENDED. To COMPLETE only by an approved request; back down is immediate |
| Mapping | PENDING to MAPPED or REJECTED; either back to PENDING (reopen) |
| Agency | ACTIVE or INACTIVE (edit), SUSPENDED (approved request only) |
| Markup rule | DRAFT to ACTIVE (approved), ACTIVE or DRAFT to RETIRED; immutable |
| Hold | PENDING_RECHECK, RECHECKED, HOLD_PENDING, HELD, PROCESSING, CONFIRMED, RELEASED, EXPIRED, FAILED |
| Booking | PENDING, CONFIRMED, CANCELLED, FAILED |
| Approval | PENDING, APPROVED or REJECTED or CANCELLED, EXECUTED (single use) |

## 6. Money rules (non-negotiable)
1. Integer minor units plus currency everywhere. No floating point (a repository guard enforces it).
2. Markup rounds half up, per night, then sums. Totals are the sum of nights times rooms.
3. A price shown must equal the price booked, or the booking is refused with `price_changed`.
4. No currency conversion exists; a hold in another currency than the agency limit is refused, not converted.
5. Refund = cancellable amount minus penalty, computed from the contract policy, never entered by hand.
6. Nothing posts to the ledger outside a booking, cancellation or reconciliation transaction.

## 7. Failure and edge-case rules
- Supplier slow or down: classify, return `provider_unavailable`, allocate nothing, show nothing stale.
- Two agents, one last room: the guarded atomic update means exactly one wins.
- Duplicate click or retry: the idempotency key returns the same result; no double hold, booking or debit.
- Price moved between search and hold: `price_changed`, no inventory moved.
- Process dies mid-booking: the hold stays PROCESSING; reconciliation resolves it; compensation releases funds and inventory.
- Policy missing at cancellation: refuse and escalate to manual review; never guess a penalty.
- Unreadable credit table: refuse the hold (fail closed); unreadable image table: omit images (not misleading).

## 8. Operations and metrics a bedbank runs on (**Proposed**; none are dashboards today beyond the Admin summaries)
Look-to-book ratio and conversion by agency; search latency and supplier error rate; hold-to-booking conversion and hold expiry rate; margin per booking and by supplier; net versus sell variance; cancellation rate and penalty income; credit utilisation per agency; stuck holds and reconciliation age; content completeness and sellable-hotel count; rate and inventory freshness by supplier.

## 9. Gap register: what a production bedbank still needs, in a sensible order

| # | Capability | Why it matters | Depends on |
|---|---|---|---|
| 1 | Wallet funding and payments (top-up, payment links, receipts). ADR 0028 accepted in part; slices 1 (agency accounts), 2 (manual bank-transfer funding, behind FUNDING_ENABLED) 3 (bookings charge agency accounts, one credit line) and 4 (overdue controls: 7-day notice, 30-day hold refusal) built; slice 5 (card or payment-link funding) awaits a provider decision | Without money in, booking cannot launch | Owner decisions 6, 7 and the rest of 8 of ADR 0028 (fees, refunds, AML policy) |
| 2 | Supplier payables, settlement and invoice matching | Paying hotels is the other half of finance | Contract payment terms, accounting model |
| 3 | Tax and fees as separate lines; VAT invoices | Legal invoices and correct totals | Tax rules per jurisdiction |
| 4 | Markets, nationalities and channel rates | Closed-to-departure is enforced; market and nationality rules are enforced for Agent search, recheck and hold (ADR 0035). Channel rates remain out of scope | Business rules |
| 5 | Per-agency commercial profiles and price lists | Different agents get different margins | Commercial policy |
| 6 | Amendments, no-show and partial cancellation | Everyday booking operations | Supplier and policy rules |
| 7 | Live supplier connectors (first one) | Breadth beyond direct contracts | Connector contract, credentials, certification |
| 8 | Notifications (confirmation, voucher, cancellation emails) | Agent experience | Provider, templates |
| 9 | Promotions and dynamic pricing | Competitive pricing | Pricing policy |
| 10 | Lock dates / allotment pools | Protect manual rates from feeds | Connector first (ADR 0026) |
| 11 | Content enrichment and duplicate detection | Catalogue quality at scale | Content sources, licences |
| 12 | Reporting and exports | Management and finance control | Metrics definition |

## 10. Go-live gates (all must be true before booking is enabled anywhere)
1. Wallet funding and a payment path exist, tested, with idempotent webhooks.
2. Cancellation, refund and document flows are certified end to end with finance sign-off.
3. At least two staff per tenant hold the approval permissions; roles reviewed.
4. All migrations applied through the human database-grant decision (ADR 0013), with backup and restore evidence.
5. Hold expiry sweeper and reconciliation run on their restricted credential and are monitored.
6. Supplier failure, price change, and sold-out paths demonstrated in a real-stack test.
7. Dubai acceptance (100 hotels) re-run on the release candidate; no placeholder presented as a capability.
8. A rollback plan: turning `BOOKING_ENABLED` off leaves search and holds safe.

## 11. Decisions needed from the owner
Payment provider and funding model; supplier settlement terms; tax and VAT treatment; which markets and nationalities to enforce and the closed-to-departure date convention; per-agency pricing policy; whether one image is required to publish; lock-date meaning; the ADR 0013 database-grant decision.
