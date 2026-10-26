# ADR 0094: Connection budget check

## Status
Accepted. Amends ADR 0067 point 3 (budget was "an operator setting, not checked"). No runtime, schema or migration change.

## Context
ADR 0067 states the worst case, `tasks × Σ connection_limit`, must stay below `max_connections` minus reserved slots, but nothing computed it. `docs/database-search-architecture-audit-2026-10-18.md` plan item 6 left it open. ECS autoscaling allows up to `4 ×` the desired count (`ecs.tf`), so the unchecked sum is easy to get wrong.

## Decision
- `assessConnectionBudget` (`apps/api/src/database/pool-config.ts`) is a pure function over role URLs, task count, `max_connections` and reserved slots. Verdicts: `WITHIN_BUDGET`, `OVER_BUDGET`, `UNPROVEN`.
- A pool with no valid `connection_limit` makes the verdict `UNPROVEN`, never a guessed number: Prisma's default is `num_cpus * 2 + 1`, and a container may report the host's cores.
- `pnpm --filter @bedbanks/api ops:connection-budget --tasks=N --max-connections=M [--reserved=10]` reads the `*_DATABASE_URL` variables from the environment (excluding `PROVISION_`, `MIGRATION_`, `OWNER_`), connects to nothing, prints role labels and numbers only, and exits 1 unless `WITHIN_BUDGET`.
- Run it in the release checklist per environment with `tasks` at the autoscaling maximum. When every URL is a PgBouncer endpoint, `max_connections` is the pooler's client limit, not Postgres's; state which one you used.

## Consequences
The check is advisory and operator-run; it does not block startup (ADR 0067 point 5 still warns per pool). It cannot see pools created outside these variables, so a new pool holder must stay in `APPROVED_POOL_HOLDERS` and its URL must follow the `*_DATABASE_URL` naming.

## Verification
Unit tests for within, exact-fit, over, unsized, unset and invalid inputs, and that no URL, host or password is echoed. Not verified: against a real Neon `max_connections`.

## Rollback
Delete the function, CLI and `ops:connection-budget` script. Nothing depends on them.
