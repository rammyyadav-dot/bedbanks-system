# ADR 0018: Commercial markup rules for NET rates

## Status
Accepted. Adds the reviewed migration `202610090001_commercial_markup_rules`, applied only to disposable local databases. Like the approval migration it carries a conditional `GRANT` for the API runtime role, which in effect is a production privilege change: it needs the ADR 0013 human decision before any persistent environment. Without a grant, the API runtime role cannot read rules, so NET rates stay unsellable (fail closed) and the Agent search logs that.

## Context
The canonical evaluator sells only SELL-basis daily rates. A NET rate returned `NET_RATE_MARKUP_UNAVAILABLE` and markup was hard-coded to zero, so contracts priced at net could not be sold at all. `@bedbanks/pricing` held a markup helper that used floating-point rounding, which breaks the integer-money invariant.

## Decision
1. **A rule is a percent markup in integer basis points (0 to 10 000) on NET rates,** scoped to the tenant default, one supplier or one hotel. The most specific ACTIVE rule whose dates contain the night wins (hotel, then supplier, then default); an ended hotel rule falls back to the next one. No rule means no markup, so the NET rate is not sold.
2. **Exact integer maths.** `markupMinor(net, bp)` in `@bedbanks/pricing` is `(net * bp + 5000) / 10000` in BigInt: round half up, per night, then summed and multiplied by rooms. `applyPercentMarkup` now delegates to it. A rule outside 0..10 000 is treated as no rule.
3. **One evaluator.** The markup is applied inside `evaluateContractedStay`, fed by a per-night basis-points value that `buildStaySnapshot` takes from a resolver. Agent search, recheck, the Admin hotel assessment, the calendar and the sellability inspector all use it, so they cannot disagree. The decision now returns `netMinor` and `markupMinor` beside `totalMinor`; the offer reports `netAmountMinor`, `markupAmountMinor` and `sellAmountMinor`, and `totalAmountMinor` stays supplier cost so the offer contract (sell = total + markup) holds.
4. **Price integrity.** Recheck re-prices through the same path. A rule change between search and recheck returns `price_changed`; a price is never replaced silently. The wallet is debited the sell amount, as before.
5. **Rules are immutable; only the status moves.** DRAFT to ACTIVE only through an approved, single-use maker-checker request (ADR 0016 and 0017, approval action `markup.activate`, S3); ACTIVE or DRAFT to RETIRED directly. There is no update and no delete. Activation re-checks that the rule is still a DRAFT exactly as approved, and retires the rule it replaces in the same transaction.
6. **Database guarantees.** A partial unique index allows one ACTIVE rule per (tenant, scope, supplier, hotel); CHECK constraints fix the basis-point range, validity order, scope-target consistency and status timestamps. Forced row-level security, tenant indexes, and audit events for creation, activation and retirement.
7. **Permissions.** Reads need `supply.rates.read`; every change needs `supply.rates.manage`. No new permission name; `markup.activate` is an approval-only action that refines `supply.rates.manage`. Requester and approver are different people, enforced by the approval service and a database CHECK.
8. **Rule reads are fail-closed and observable.** The loader runs in its own transaction (or a SAVEPOINT inside the caller's) so a denied read cannot abort the surrounding work. A denied read yields no rules and a warning, never a default markup.

## Decisions left to the business
- The cap of 100 percent, round-half-up, and per-night rounding are defaults that can change with a new ADR.
- Markup applies to NET rates only. Taxes, fees, per-agent or per-market pricing, promotions and currency conversion are not modelled.
- Whether approval should also be required to retire an ACTIVE rule. Retiring is the safe direction (it removes sellability), so it is direct today.

## Consequences
- Contracts priced at net become sellable once a rule is activated. Admin readiness reflects that through the same evaluator.
- The Commercial department has one live module, Markups. Promotions and pricing analysis are not built.
- Rollback: retire all rules (NET rates stop selling) or remove the table through a forward migration; the notes are in the migration header.
