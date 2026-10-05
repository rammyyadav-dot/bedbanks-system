# ADR 0034: A daily rate must be greater than zero

## Status
Accepted for the API code, tests and one forward migration, replayed only on disposable local databases. Applying `202610240001_daily_rate_amount_positive` to any persistent database is an owner-controlled release step.

## Context
The rate certification audit (ADR 0033) found that `DailyRate_values_check` allows `amount_minor >= 0` and that `evaluateContractedStay` and `evaluateNightSellability` rejected only a *negative* amount. A zero-amount night was therefore priced and sold for nothing. Quick Update already refused a zero price; the supply `upsertDailyRate` route and direct database writes did not.

## Decision
1. **Evaluator.** A stored amount of zero or less is `DAILY_RATE_MISSING_OR_INVALID` in both evaluators, so search, recheck, hold, the Admin assessor, the Sellability Inspector and the simulator all refuse the night, with no total. This is the control that protects buyers regardless of what is in the table.
2. **Write path.** `upsertDailyRate` returns 400 for an amount of zero or less (Quick Update already did).
3. **Database.** `ALTER TABLE "DailyRate" ADD CONSTRAINT "DailyRate_amount_positive" CHECK (amount_minor > 0) NOT VALID`. PostgreSQL enforces it for every INSERT and every UPDATE from now on and does not scan or rewrite existing rows, so legacy zero rows are neither repaired nor deleted. The older `>= 0` check stays; the two together mean "positive".
4. **Validation is a separate, owner-run step.** After the rate certification audit shows no `RATE_AMOUNT_ZERO` on the target database, run `ALTER TABLE "DailyRate" VALIDATE CONSTRAINT "DailyRate_amount_positive"`. It does not block reads or writes and fails, changing nothing, while a zero row remains.

## Consequences
- Legacy zero rows stay visible: the audit still reports them (`RATE_AMOUNT_ZERO`, P0) and the evaluator refuses them. Behaviour change for sellers: those nights stop selling, which is the intended fix.
- On a database that holds a zero row, an UPDATE that touches that row without correcting the amount is refused. Correct the rate through Quick Update (or close the night); this is the only operational impact.
- No grant, RLS policy, index or table change. Tenant-index review: none needed (a CHECK adds no index).
- Rollback: `ALTER TABLE "DailyRate" DROP CONSTRAINT "DailyRate_amount_positive"`; revert the evaluator change in code.
- Test fixtures that need legacy zero rows (the rate-certification e2e and browser seed) drop the constraint while seeding and restore it `NOT VALID`, exactly as the migration leaves it.
