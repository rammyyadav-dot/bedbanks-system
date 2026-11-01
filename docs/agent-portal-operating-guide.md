# Agent Portal (`apps/agent`): CTO operating guide

Audience: CTO, product, ops, finance, support and engineering. Grounded in the code at `main` (cloned 2026-10-19) and ADRs 0010, 0014, 0018, 0020, 0024, 0028, 0029, 0065, 0066, 0072. Where the code or an ADR says something different from the brief this guide was written from, the code wins and the difference is flagged in section 10.

Status tags: **LIVE** works with no flag. **GATED** built but behind a server flag. **NOT BUILT** do not promise it to an agency.

---

## 1. Access and authentication

| Item | Fact | Source |
|---|---|---|
| Local URL | `http://localhost:3000` (`pnpm --filter @bedbanks/agent-portal dev`); API on `:3002` | `apps/agent/package.json`, `.env.example` |
| Hosted URL | Your agent origin, e.g. `https://agent.<domain>`. Browser calls are same-origin `/api/v1/*`; `proxy.ts` rewrites them to `API_INTERNAL_URL` on every request, so one image serves every environment and the session cookie stays host-only | ADR 0010, `proxy.ts` |
| Required env | `API_INTERNAL_URL` (build fails on Vercel without it). `NEXT_PUBLIC_AGENT_API_URL` is a test/tooling override only; never put secrets in `NEXT_PUBLIC_*` | `.env.example`, `lib/api-config.mjs` |
| Credentials | Email + password of an agency member. Session is an opaque HttpOnly cookie (no JWT, nothing in localStorage). Login failures are generic ("Invalid credentials"). Login throttling exists in the API (`auth/login-throttle.ts`) | ADR 0001 |
| Session expiry | Any 401 outside login/context fires `fbeds:session-expired`; the auth gate returns to sign-in with the expiry notice | `lib/session-events.mjs` |
| Multi-agency users | Must pick a workspace. The browser sends `x-fbeds-tenant-id` only as a *request*; the API checks it against the session's memberships, reloads the membership row, and uses the server value for every query. A missing header is accepted only for a single-membership user | `tenant-context.guard.ts` |

### Authorization layers (a request must pass all of them)

1. **`SessionAuthGuard`**: valid opaque session.
2. **`TenantContextGuard`**: membership exists, is not revoked, tenant is `ACTIVE`. Writes `tenant.context.selected` / `tenant.access.denied` audit events.
3. **`AgentRbacGuard`**: the handler must declare a permission (no declaration = 403, fail closed). Granted by formal role permissions; legacy `owner` membership grants all; legacy `finance` membership grants only `finance.read`. Denials write `permission.denied`.
4. **`AgencySuspensionGuard`**: suspended agency gets 403 `AGENCY_SUSPENDED` on new commercial routes.

| Permission | Unlocks |
|---|---|
| `hotel.search` | destinations, facets, search, Smart Search parse, recheck, hotel images |
| `booking.prebook` | create/release hold, prebook, declare funding receipt |
| `booking.create` | confirm booking |
| `booking.read` | list/detail bookings, voucher/invoice/credit-note |
| `booking.cancel` | cancellation quote, cancel |
| `finance.read` | finance summary (wallet screen) |
| `audit.read` | agency audit trail |
| `booking.reconcile` | reconcile stale bookings |

> **Correction to the brief:** `apps/agent/lib/session-capability.test.mjs` does **not** test RBAC. It pins the `bookingEnabled` UI flag: true only for an explicit boolean `true` from `/agent/context`, replaced on every new context. RBAC is tested in `apps/api/src/agent/rbac.guard.spec.ts`, `agent-permissions.spec.ts` and `tenant-context.guard.spec.ts`. The UI flag is a hint; the API enforces.

`GET /agent/context` returns user, memberships, effective `capabilities`, `bookingEnabled`, `settlementCurrencies`. The portal hides "My bookings" unless `bookingEnabled` is true and hides "Wallet" when `finance.read` is denied.

---

## 2. Portal map

Navigation (`components/agent-portal.tsx`): **Home**, **Hotel search**, **My bookings** (only if booking enabled), **Wallet** (only with finance access), **Account**. Public pages: `/`, `/about`, `/support`, `/contact`, `/news`, `/access`, `/login`. Post-login return paths are allow-listed (`lib/return-path.ts`) so open redirects are impossible.

Layering inside the app: components → `services/` (`ApiHotelService`, `BookingService`) → `lib/api-client.ts` → `@bedbanks/contracts` types. Frontend consumes contracts only (constitution rule 4); domain/pricing/money packages are transport-agnostic.

---

## 3. Search and rate shopping (LIVE for contracted inventory)

**Inputs**
- Destination: a **canonical** city or hotel chosen from typeahead (`GET /agent/destinations`); free text is never a destination (ADR 0014). Typeahead is typo-tolerant (`pg_trgm`, ≥0.35 word similarity), alias-aware (دبي/Dubaï → Dubai), cached 60 s per tenant+query (ADR 0065).
- Stay: 1–30 nights, dates in the Asia/Dubai business calendar.
- Occupancy: up to **8 rooms**, per-room adults (≤8) and child ages (≤6 children). Mixed room occupancies are carried on the request but **not priced** (ADR 0014).
- Guest nationality (default IN) and selling currency (default AED).
- **Smart Search**: paste a client email → `POST /agent/search/parse` fills fields deterministically (no LLM). It never invents a value; unresolved fields stay as the agent had them. Pasted text is not stored or logged.

**Filters and sort** (applied *before* the 25-row page window): star rating, refundable only, **board basis** (values come from `GET /agent/search-facets`, i.e. what the tenant's catalogue actually stores), property type, min/max price (integer minor units). Sort by price, stars, name.

**Result rules**
- A hotel is returned only if **every night** passes: published hotel, ACTIVE supplier and contract, MAPPED hotel+room, ACTIVE rate plan, rate for occupancy+currency, availability, no stop-sell, min/max stay, release days.
- Cheapest valid supplier wins per hotel. Inventory is **not cached**, so stop-sell and rate edits show on the next search.
- Offer contract is nested hotel → room → rate with `Money {amountMinor, currency}`, expiry, cancellation terms, board, optional `payAtHotel` charges and `priceIncludes`. The browser validates the version and echoed search context before rendering (`validateAgentSearchResponse`); a malformed response becomes `mapping_unavailable`, not a half-rendered list.
- Statuses the UI distinguishes: `available`, `empty` (no availability), `provider_unavailable`, `mapping_unavailable`, `destination_unavailable`, `auth_required`, `access_denied`, `agency_suspended`. **Supplier failure never turns into demo, stale or zero-priced inventory** (constitution rule 5). A failed refresh keeps the previous good result on screen.
- Concurrency: a newer search invalidates an older in-flight one (`search-attempt.ts`), so a slow response cannot overwrite fresh results. Client timeout is 10 s.

---

## 4. Pricing logic

| Layer | Rule |
|---|---|
| Money | Integer minor units + ISO-4217 everywhere; no floats. Display formatting only (`lib/format.ts`) |
| Net → sell | NET rates sell only when an ACTIVE markup rule applies: basis points 0–10,000, scope hotel > supplier > tenant default, `(net × bp + 5000) / 10000` half-up **per night**, summed, × rooms. No rule = not sellable (ADR 0018). Activation is maker-checker |
| Net rates | All-inclusive of taxes at launch; no separate tax/fee lines (ADR 0029) |
| Pay-at-hotel | Charges like tourism dirham are shown separately ("about AED 60 for this stay"), **never added to the total** and never posted to the ledger; the agent must tell the guest (`lib/pay-at-hotel.ts`) |
| Client markup | Display-only 0–50% (0.01% steps, basis points, BigInt via `@bedbanks/pricing`). Stored per user+tenant in browser storage. **Never sent** with search, recheck, hold or booking; the server always uses the agency price (ADR 0065) |
| Currency | **AED only by default.** `SETTLEMENT_CURRENCIES` env can enable more; the portal picker reads `/agent/context`. **No FX conversion exists**; a non-enabled currency is refused with `CURRENCY_NOT_ENABLED` |

---

## 5. Booking workflow (GATED by `BOOKING_ENABLED=true`)

With the flag unset, the API answers `booking_unavailable`/503 and the UI says "Booking is not enabled for this workspace yet." This is deliberate fail-closed.

```
Select rate ─► RECHECK ─► HOLD ─► CHECKOUT (prebook) ─► CONFIRM ─► voucher + invoice + email
               5 s        ≤15 min    guests, terms        one DB tx
```

1. **Recheck** (`POST /agent/rates/recheck`, `hotel.search`): re-prices through the same evaluator. Outcomes: `rechecked`, `price_changed`, `unavailable`, `offer_expired`, `mapping_invalid`, `provider_unavailable`, `rejected`. A changed amount or currency never allocates anything and is never swapped silently; the agent must accept the new price.
2. **Hold** (`POST /agent/offers/:id/hold`, `booking.prebook`): client sends only `searchId`, expected currency and expected sell amount plus an idempotency key. In one transaction under an advisory lock: credit/overdue checks, then `held` reserved on **every night** (never above allotment). TTL = **min(offer expiry, 15 minutes)**. Same key returns the same hold; same key with a different request is a 409. The agent can release an unclaimed hold (`DELETE /agent/holds/:id`); a sweeper expires the rest (needs its own restricted DB credential, ADR 0005).
3. **Credit rules at hold time** (details in section 6): suspended → 403 `AGENCY_SUSPENDED`; over limit → 403 `AGENCY_CREDIT_LIMIT_EXCEEDED`; wrong currency → 403 `AGENCY_CREDIT_CURRENCY_MISMATCH`; unreadable → 503 `AGENCY_CREDIT_UNAVAILABLE` (retryable); 30+ days overdue → `AGENCY_CREDIT_OVERDUE`; no agency → `AGENCY_REQUIRED_FOR_BOOKING`.
4. **Checkout / prebook** (`POST /agent/prebook`): every guest by room (title, first/last name; children's ages must equal the searched ages; lead = first adult of room 1), optional agency reference (≤60), non-binding special requests (fixed codes + ≤300-char note + arrival time), and **mandatory `termsAccepted`**. Names validated client and server with the same rule. Probable duplicates (same guest, hotel, dates) return `DUPLICATE_BOOKING_SUSPECTED` listing existing references; the agent may re-submit with `acknowledgeDuplicate`. Prebook claims the hold (HELD → PROCESSING, so the sweeper cannot release it mid-checkout), authorizes funds, and calls the supplier prebook with a durable journal.
5. **Confirm** (`POST /agent/bookings`, `booking.create`): one transaction locks booking/hold/wallet, requires the prebook marker, moves `held`→`sold` per night, converts the HOLD into a DEBIT, confirms, audits. Idempotent. Up to 3 CC addresses (agent's own address is always included).
6. **Documents and email**: voucher + invoice issued once, immutable. Confirmation email is a transactional outbox through SES (queued in the same tx; retries at 1/5/15/60 min). With the dispatcher off, the UI honestly says "queued", not "sent" (ADR 0066).

**Transaction state machine** (`booking-transaction-state.ts`): `RECHECKED → INVENTORY_HELD → FINANCE_AUTHORIZED → PREBOOKED → BOOKING_PENDING → CONFIRMED`; `UNKNOWN` (supplier outcome unproven) is recoverable and can never jump to CONFIRMED; `FAILED`/`CONFIRMED` are terminal.

**Agent-facing language** (`lib/booking-attention.ts`): an uncertain supplier outcome (`UNKNOWN`/`SENDING`/`PREPARED`) shows as **"Confirmation pending – do not submit another booking for the same stay"**, never as "failed". Supplier references appear only on a CONFIRMED booking with an acknowledged mutation.

**"Instant vs hold-based":** there is one path (hold → prebook → confirm). "Instant" is the same path run without pausing; the hold is what protects price and inventory.

---

## 6. Money: credit, wallet, funding

- **Agency account** per agency and currency; append-only ledger is the only book of record (CREDIT, HOLD, RELEASE, DEBIT, REFUND). Balance = sum of entries (ADR 0062, 0068).
- **Spend power** = balance + approved credit line − pending holds. Prepaid agencies (money, no credit line) book up to balance. A user in no agency cannot book.
- **Credit limit** (ADR 0024): ceiling on committed holds (HOLD_PENDING/PROCESSING/CONFIRMED, or HELD and unexpired). Exactly-at-limit allowed; **no override**. Changes are maker-checker. No limit row = not limited (shown as such), distinct from zero.
- **Overdue controls** (ADR 0028 slice 4): FIFO aging of settled charges only. **7 days** unpaid → NOTICE banner in Wallet; **30 days** → new holds/bookings refused until a payment settles the oldest charge. Constants: `AGENCY_CREDIT_TERMS`.
- **Funding** (GATED by `FUNDING_ENABLED`): bank transfer only. The agent *declares* a receipt (`booking.prebook`); it moves no money until finance verifies against the bank statement and posts it. Posting above AED 10,000, cash, or third-party payers need a second approver/compliance clearance.
- **No card or payment-gateway integration exists.** Do not describe one.
- The Wallet screen shows the available credit, limit and used amounts. **Statement export is visibly unavailable** until ledger detail is connected.

---

## 7. Reservations: view, cancel, documents

- **My bookings**: paginated list and detail with timeline, vouchers/invoices/credit notes as printable, script-free, CSP-locked HTML (`documents/:type/html`).
- **Cancel** (LIVE when booking is enabled): the agent first gets a **quote** (total, penalty, refund) from the cancellation terms **frozen at booking time**, evaluated in the hotel's time zone. Then `DELETE /agent/bookings/:id` with a reason (≤500 chars). One transaction returns inventory, posts the REFUND, cancels, audits, and issues a credit note. Unparseable or ambiguous terms are never treated as free: the API returns 409 and routes to manual review.
- **Suspended agencies** can still read bookings/documents/finance, cancel, and release holds; they cannot search, recheck, hold or book (ADR 0020).
- **Amendments:** there is **no agent self-service amendment screen** (no code in `apps/agent`). Date/room/occupancy changes are handled by the bedbank's ops team through the Admin booking module, where the approver records the supplier-confirmed price and the system computes the difference (ADR 0072). Agents ask support; the practical self-service route is cancel + rebook, subject to the penalty.
- **Stale bookings**: users with `booking.reconcile` can trigger `reconcile-stale`; ops resolves stuck PROCESSING holds with maker-checker (ADR 0017).

---

## 8. Governance, security, observability

- **Constitution** (`CLAUDE.md`): server-derived tenant identity; permission on every tenant route; integer money; contracts before UI; observable supplier failure; idempotent mutations; encrypted credentials only; immutable audit; provider types stay in connectors; never present a placeholder as a capability.
- **Audit**: login, logout, tenant context, permission denial, hold create/process/release/expire, booking and cancellation, credit-limit change, suspension. Payloads carry ids/amounts, never guest PII.
- **Proxy fails closed**: `portal_api_proxy_unavailable` is logged with a fixed reason code only (never the URL).
- **Error mapping on the client** (`booking-service.ts`): 401 → sign-in; 403 → "no permission" (or suspended / credit message); 404; 409/422 conflict; 410 gone (expired); 5xx → "Nothing was changed." Ambiguous reconciliation 503 surfaces as "Reconciliation required".
- **Tests to run on every portal change**: `pnpm --filter @bedbanks/agent-portal test` (node:test over `lib/` and `services/`, including `no-demo-data.test.mjs`), `pnpm type-check`, `pnpm lint`, `pnpm check:architecture`. API: `pnpm --filter` the API's specs for `apps/api/src/agent/*`.

---

## 9. Release-readiness checklist (what must be true before an agency goes live)

| # | Gate | Check |
|---|---|---|
| 1 | Hotels published, contracts ACTIVE, rate basis (SELL/NET) classified, NET markup rule ACTIVE | Admin readiness inspector |
| 2 | Agency ACTIVE, members have formal roles (don't rely on legacy `owner`) | Admin → Agents & Clients |
| 3 | Credit limit approved (or prepaid funding posted) | Admin credit panel; Wallet shows it |
| 4 | `BOOKING_ENABLED=true`, `SETTLEMENT_CURRENCIES` reviewed, `FUNDING_ENABLED` decided | API env |
| 5 | Hold-expiry sweeper enabled with its own restricted DB credential | ADR 0005 |
| 6 | Email dispatcher + SES (`EMAIL_DISPATCH_ENABLED`, `EMAIL_FROM`) or accept "queued" copy | ADR 0066 |
| 7 | Strict runtime DB role + grants applied (credit and markup fail closed without them) | ADR 0031, 0040 |
| 8 | Smoke path: sign in → search Dubai → recheck → hold → checkout → confirm → voucher → cancel quote → cancel | e2e suite (`e2e/`) |

---

## 10. Where the brief differs from the code (do not repeat these to customers)

| Brief says | Reality |
|---|---|
| Real-time inventory aggregated from multi-supplier connectors | **Contracted (direct) Dubai inventory is live.** Third-party supplier connectors are a defined boundary with **none live**; supplier failures surface as `provider_unavailable` (`docs/bedbank-operating-model.md` §4.12) |
| Multi-currency pricing with FX rates | **AED-only at launch, no FX** (ADR 0029). Other currencies are env-enabled settlement currencies, never converted |
| Board filter RO/BB/HB/FB/AI | Board values are **tenant catalogue records** returned by `search-facets`; "breakfast" is matched by exact board name, not a fixed code list |
| "Dynamic contract rates" | Rates are per rate plan/night/occupancy with markup rules; promotions, per-agency price lists and dynamic repricing are **NOT BUILT** |
| Payment gateways | **NOT BUILT.** Credit line, prepaid wallet and bank-transfer funding only |
| Self-service date/room amendments | **NOT BUILT** for agents (Admin-side only, ADR 0072). Cancel and rebook, or contact support |
| `session-capability.test.mjs` proves RBAC | It proves the `bookingEnabled` flag. RBAC specs live in the API |
| `CTO_AGENT_PORTAL_HARDENING_REPORT.md` says booking disabled / adapter unconfigured | That report is a point-in-time snapshot of an earlier branch; the API now has hold, prebook, confirm, cancel and documents behind `BOOKING_ENABLED`. Treat the flag, not that report, as current |

## 11. Recommended next investments (CTO view, ordered)

1. **Live supplier adapter + authoritative recheck** (unblocks multi-supplier breadth; contract is already defined in `@bedbanks/domain`).
2. **Agent amendment request** (structured dates/occupancy request feeding the ADR 0072 Admin workflow) to remove the cancel-and-rebook penalty exposure.
3. **Ledger statement export + per-agency statements** (Wallet currently says export unavailable).
4. **Payment link/gateway** for top-ups, to cut the manual bank-reconciliation loop.
5. **Per-agency price lists / markets** and promotions (needs ADR; touches pricing evaluator).
6. **CSRF policy for cookie-authenticated mutations and browser E2E in CI** (listed as open in `docs/agent-login-security-hardening.md`).
