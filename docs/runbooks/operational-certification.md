# Runbook: operational certification

Certifies the commercial chain and the privileged mutations that sit on it: hotel to contract to rate plan to inventory to sellability; booking, hold, cancellation and reconciliation; four-eye activation, markup, funding and suspension; and the audit events and request IDs those mutations write. This is a certification of code already in the repository. Re-run it when those paths change.

## Scope boundary

Disposable local PostgreSQL 16 only (`fbeds_ci` on `127.0.0.1`). `prisma migrate deploy` against that empty database. Nothing here touches a hosted, staging or production database, a live supplier, or a live payment. Booking suites use the in-process test adapter (`chain-test-adapter` or the unconfigured supplier), so this run does not certify a supplier transport.

Most suites connect as the disposable owner. Suites that provision a non-bypass role inside the test (`HOTEL-OPS-RLS`, `HOTEL-OPS-RUNTIME-ROLE`, `CM-13`, `DS-04`, `ADMIN-RLS`, `ADMIN-DENIED`) still pass on this database. That is not a substitute for the hosted strict-login procedure in `docs/runbooks/rate-plan-ops-role-certification.md`.

## What is certified

| Property | What the run proves | Suite |
|---|---|---|
| Hotel → contract → rate → inventory → sellability | List, contract state, missing rate, missing availability, stop-sell and exhausted stock are named by the API. A stay the inspector calls sellable is the stay Agent search offers. | `hotel-commercial.e2e-spec.ts`, `inventory-search-recheck.e2e-spec.ts` |
| Hold | An active hold consumes inventory without overselling. Hold expiry and the hold HTTP path stay consistent with the grid. | `hotel-commercial.e2e-spec.ts` (`HOTEL-OPS-15`), `inventory-hold.e2e-spec.ts` |
| Booking | Recheck → hold → prebook → confirm → documents → cancel → credit note, with replay and concurrent races. | `booking-lifecycle-chain.e2e-spec.ts` |
| Cancellation | Integer penalty, frozen terms, one refund under concurrency, fail-closed cases, admin release of sold stock. | `booking-cancellation.e2e-spec.ts` |
| Reconciliation | Stale-hold sweep returns wallet and inventory once, refuses to release a successful prebook, and leaves an unobserved timeout as manual review. Admin dry-run changes nothing; a run goes through that service. | `booking-reconciliation.e2e-spec.ts`, `admin-operations.e2e-spec.ts` (`ADMIN-RECON`) |
| Four-eye rate-plan activation | Direct activation is closed when approval is required. Request, a different person decides, execute is single-use, and a suspended plan returns only through the same approval. | `rate-plan-approval.e2e-spec.ts` |
| Contract maker-checker | Activation is a reviewed fingerprint, executed once, with a version snapshot and a `supply.contract.status_changed` audit. | `contract-approval.e2e-spec.ts` |
| Markup | A NET rate is unsellable until a second person approves and activates a rule. Sell price is integer minor units. Retiring the rule fails closed. Each step is audited. | `commercial-markup.e2e-spec.ts` |
| Funding | Declare, verify by another person, post. Above the large-receipt threshold a third person posts. `requestId` replays; a reused key for a different declaration is refused. | `agency-funding.e2e-spec.ts` |
| Suspension | Rate-plan suspension needs a reason and writes before/after status. Agency suspension is maker-checker, blocks new commercial activity for that agency only, and reinstatement is a second approval. | `rate-plan-lifecycle.e2e-spec.ts`, `departments.e2e-spec.ts` (`SU-01`, `SU-02`) |
| Audit and request IDs | Activation and suspension payloads carry the `x-request-id`, actor and before/after status. Approval requests persist `requestId` and write `approval.requested`. Funding declarations store `requestId` on the receipt and on `funding.declared`. The audit explorer filters by request id and redacts credentials, tokens and contact details. The audit service copies the request context into the payload. | `rate-plan-lifecycle.e2e-spec.ts`, `admin-operations.e2e-spec.ts` (`ADMIN-AUDIT`, `ADMIN-23`), `src/agent/audit.service.spec.ts` |

## Certification run (4 November 2026, Asia/Calcutta)

### Environment

- Source: `main` at `0d112e9effb39115ca122ddfc0077de3948499d5`.
- Database: disposable local PostgreSQL 16.15, database `fbeds_ci`, created empty for this run.
- Migrations: 134/134 applied with `prisma migrate deploy`.
- Node: 24.22.2. `NODE_ENV=test`. `DATABASE_URL` and `MAPPING_DATABASE_URL` set in the environment before Prisma and Jest, so `apps/api/.env` cannot point the run elsewhere.

### Command

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/fbeds_ci?schema=public'
export MAPPING_DATABASE_URL="$DATABASE_URL"
export REDIS_URL='redis://127.0.0.1:6379'
export NODE_ENV=test
pnpm --filter @bedbanks/api prisma:migrate:deploy
cd apps/api
pnpm exec jest --config ./test/jest-e2e.json --runInBand --forceExit \
  test/hotel-commercial.e2e-spec.ts \
  test/inventory-search-recheck.e2e-spec.ts \
  test/inventory-hold.e2e-spec.ts \
  test/rate-plan-lifecycle.e2e-spec.ts \
  test/rate-plan-approval.e2e-spec.ts \
  test/contract-approval.e2e-spec.ts \
  test/commercial-markup.e2e-spec.ts \
  test/agency-funding.e2e-spec.ts \
  test/booking-lifecycle-chain.e2e-spec.ts \
  test/booking-cancellation.e2e-spec.ts \
  test/booking-reconciliation.e2e-spec.ts \
  test/admin-operations.e2e-spec.ts \
  test/departments.e2e-spec.ts
pnpm exec jest --runInBand src/agent/audit.service.spec.ts
```

### Result

| Suite | Result |
|---|---|
| `hotel-commercial.e2e-spec.ts` | pass |
| `inventory-search-recheck.e2e-spec.ts` | pass |
| `inventory-hold.e2e-spec.ts` | pass |
| `rate-plan-lifecycle.e2e-spec.ts` | pass |
| `rate-plan-approval.e2e-spec.ts` | pass |
| `contract-approval.e2e-spec.ts` | pass |
| `commercial-markup.e2e-spec.ts` | pass |
| `agency-funding.e2e-spec.ts` | pass |
| `booking-lifecycle-chain.e2e-spec.ts` | pass |
| `booking-cancellation.e2e-spec.ts` | pass |
| `booking-reconciliation.e2e-spec.ts` | pass |
| `admin-operations.e2e-spec.ts` | pass (15) |
| `departments.e2e-spec.ts` | pass (13) |
| `src/agent/audit.service.spec.ts` | pass (3) |
| **Total** | **13 e2e suites, 219 tests, plus 3 unit tests. 0 failed.** |

Logged `ERROR` lines in `booking-cancellation` (`Booking module connection refused or lacks a grant (42501)`) are the suite's own assertion that admin cancellation fails closed when the booking role is absent. They are not failures of the run.

## Conditions

- This is source-and-disposable-database evidence. It does not certify a hosted runtime login, `fbeds_rateplan_ops` provisioning, or a production grant review. `ADMIN-DENIED` still expects transaction tables to answer `OPERATIONS_READ_DENIED` for a role without those grants.
- Supplier statement reconciliation and bank reconciliation (ADR 0070 / ADR 0093) are a separate finance workflow and were not part of this run. Booking reconciliation here is the stale-hold sweep and the Admin action over it.
- Markup and funding audits record the action and, for funding, the declaration `requestId`. The assertion that the HTTP `x-request-id` is stored on the audit payload is explicit for rate-plan activation and suspension, and for the audit explorer. Approval rows store their own `requestId`, which the four-eye suites replay.

## Verdict

**CERTIFIED** for the disposable single-database path above, at `0d112e9effb39115ca122ddfc0077de3948499d5`. Re-run this runbook before treating a later commit as certified. Hosted strict-role certification remains a separate procedure.
