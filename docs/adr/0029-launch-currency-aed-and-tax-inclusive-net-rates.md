# ADR 0029: Launch currency AED, and net rates that are all-inclusive of taxes

## Status
**Accepted** (owner decision). This records the decision and what follows from it. The "Enforcement" section lists what the code does versus what remains to build. AED-only is now enforced in code (this change); the tax-inclusive flag is not built. It also settles two items proposed in ADR 0028.

## Decision
1. **Launch currency is AED only.** Contracts, rates, selling prices, holds, bookings, wallets, receipts, refunds and statements are in AED. No other currency is offered at launch.
2. **Net rates are all-inclusive of taxes.** A supplier net rate is the final amount the bedbank pays for the stay, with every tax and mandatory charge already included. fBeds does not model tax or fee as separate lines at launch.

## What this means in the business rules
- **One amount per night.** `netAmountMinor` is the all-in cost; the evaluator's `taxAmountMinor` and `feeAmountMinor` stay 0 (as the contracted adapter already sets them) and the total is net plus markup. This closes, for launch, the "taxes and fees as separate lines" gap in `docs/bedbank-operating-model.md`.
- **Markup applies to the all-inclusive net** (ADR 0018, basis points, round half up, per night). The sell price is therefore also all-inclusive from the agent's side.
- **Contracts must say so.** A rate load or contract that is not tax-inclusive is not accepted at launch: it would be mis-priced, because the platform would treat an exclusive amount as all-in. The rule belongs on the contract and the rate plan (a declared "tax inclusive" flag), set by the person who loads it.
- **Local charges are out of the price.** Charges the guest pays at the property (for example a tourism fee collected at the hotel) are not part of the net or sell amount. They are shown as hotel policy or information, never added to the total, never posted to the ledger.
- **Wallet and credit (ADR 0028):** one currency removes the multi-currency cases for launch. Accounts, funding receipts, credit lines, refunds and aging are AED. A receipt in another currency is rejected, not converted.
- **No FX.** There is no currency conversion at launch; none is needed.
- **Documents.** The invoice and voucher show one all-inclusive AED amount. Whether the invoice must also state the VAT component (and a tax registration number) is a legal and accounting question, not decided here.

## Enforcement: what is true today and what is not
| Rule | Today | To build |
|---|---|---|
| AED only | **Enforced (follow-up).** The enabled list is `SETTLEMENT_CURRENCIES` (comma-separated ISO codes), **AED when unset**, and a malformed value fails startup. Contract, rate plan and rate writes, Agent search, hold and recheck, the Agent currency picker (from `/agent/context`), tenant settings defaults and the wallet funds check all use it. The default Agent search currency is AED. Anything else is refused with `CURRENCY_NOT_ENABLED` | Remove the other 13 codes from the Admin tenant-settings currency list (the server already refuses them) |
| Tax and fee lines zero | The contracted adapter sets `taxAmountMinor` and `feeAmountMinor` to 0 | Keep; add a test that a priced stay has zero tax and fee |
| Tax-inclusive contracts | **Not built.** There is no declared flag; a rate cannot say whether it is inclusive | Add a tax-inclusive flag on contract or rate plan (migration), required to be true to sell at launch; Admin shows it |
| Local charges outside the price | Hotel policies can record local charges as information; they are not in totals | Keep; document in the Policies tab help |
| Margin tax | Not modelled | Accountant decision (see below) |

### Test harness note
The existing API suites were written when 14 currencies were enabled, so the jest setup (`test/currency-policy.setup.ts`) enables the full list for them unless a suite sets `SETTLEMENT_CURRENCIES` first. The AED default itself is covered by `currency-policy.spec.ts` (unit) and `agent-aed-policy.e2e-spec.ts` (HTTP, started with AED only).

## Open questions this decision does not answer
1. **VAT on the bedbank's margin and on invoices.** With all-inclusive nets, how the margin is taxed and what the invoice must show (UAE VAT treatment, tax registration number, tax invoice wording) needs the accountant. fBeds can record one all-inclusive amount, but cannot decide the legal presentation.
2. **Tourism or municipality fees collected at the hotel** are assumed to stay outside the price; confirm per supplier.
3. **When a second currency is wanted**, a new ADR must cover pricing, accounts, FX source and gain or loss, because several current rules assume one currency.

## Consequences
- Pricing, finance and documents for launch are simpler and fully integer-AED.
- The wallet and credit design of ADR 0028 can drop its multi-currency edge cases for launch (its "currencies at launch" decision is **AED**).
- Two small build items follow (restrict and default currency; tax-inclusive flag), both safe and testable, and neither enables booking or payment.
- Rollback: this ADR is policy; reverting it means a new ADR plus the work needed to support tax lines or more currencies.
