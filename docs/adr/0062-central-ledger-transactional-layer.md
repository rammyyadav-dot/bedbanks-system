# ADR 0062: One transactional ledger layer

Status: **Built (behaviour-preserving refactor, no schema change).**

## Finding
The same ledger rules were written out by hand in many places: five separate `ledgerEntry.create` sites (hold authorization, hold release, confirmation settle, cancellation refund, funding post) and `LedgerService.post`, plus the balance sum and the formula `available = credit line + balance - pending` in eight read paths (agent finance summary, agency position, the Admin wallets list, agency account, receivables, the finance audit summary). Only `LedgerService.post` checked a zero amount or an empty idempotency key; no site checked the sign a kind of entry must carry. A change to one copy could silently diverge from another, and reconciliation reports would then disagree with the booking path that actually authorizes spend.

Currency conversion: there is **no FX conversion in the ledger or finance code** (ADR 0028, ADR 0029; currencies are never converted or added). The duplicated currency logic was the per-currency grouping and the "available credit" arithmetic, which are now shared. No conversion was added.

## Decision
1. **Pure arithmetic** in `@bedbanks/money` (`ledger.ts`): sign rule per entry kind, balance, `availableMinor`, `canSpend`, `isOverdrawn`, `refundWithin`, `positionsByCurrency`. Integer minor units as bigint, no I/O, no framework; currencies are separate rows and never added.
2. **One transactional layer** in the API (`apps/api/src/ledger/ledger-core.ts`): `appendLedgerEntry` (the only writer of `LedgerEntry`), `walletBalanceMinor`, `walletTotals`, `ledgerWindowGroups`. Functions take the caller's tenant transaction; they open none, take no lock and post no audit event, so each caller keeps its own wallet row lock, idempotency lookup and audit event inside its business transaction.
3. **Enforced:** `pnpm check:ledger-single-writer` (part of `check:architecture`) fails if API code outside the core writes `LedgerEntry` or sums it directly. Specs are exempt.

## Rules now enforced at every append
Non-zero amount; non-blank idempotency key; ISO-4217 alpha currency; CREDIT, RELEASE and REFUND positive; DEBIT and HOLD negative. Every existing production posting already satisfied these; the one spec fixture that stored a REFUND as negative was corrected.

## Unchanged (deliberately)
Schema, migrations, grants, runtime roles, API routes and contracts, idempotency keys and references, the wallet row lock and advisory lock order, and the binding financial authorization. Appends do not re-check that the currency is currently enabled, so a refund or release for an existing booking cannot fail because a currency was later disabled.

## Verified
Money package tests (10), API unit suite (1223 passed, 3 skipped, as before), type-check, lint, `check:architecture`. **Not run:** the Postgres e2e suites (no database server in this environment) and the browser. Run `ledger-financial-safety`, `booking-cancellation` and `admin-operations` e2e in CI before release.

## Not done / next
- Nightly check that the ledger sum equals reconciliation figures per account, and a reconciliation report built on the shared functions.
- `Wallet.cached_balance` is still unmaintained and unused; drop or maintain it in a reviewed migration.
- Manual adjustments, reversals, supplier payables writes and gapless credit-note numbering remain the undecided items in ADR 0028 and ADR 0054.
