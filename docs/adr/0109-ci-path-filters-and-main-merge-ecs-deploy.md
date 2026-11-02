# ADR 0109: Path-filtered CI and merge-to-main ECS Fargate delivery

Status: Accepted (2026-11-02)

## Context

`ci.yml` ran every release job (Prisma certification against disposable PostgreSQL, the full verify suite, the three-portal Playwright suite, website production checks) on every pull request and every branch push. That is the right bar for `main` and for a deploy SHA, but a documentation-only PR paid the same cost.

`deploy.yml` was a five-minute echo that told operators to use the AWS workflows by hand. Staging delivery already existed in `staging-release.yml` (ADR 0090) but the named `deploy.yml` file was not the merge-to-main path.

## Decision

1. **Path filter.** `ci.yml` classifies the changed files (`tools/ci-path-filter.mjs`). `main` always runs every job. Pull requests and other branches skip Prisma certification, verify, the portal e2e suite or website checks when those trees are untouched. Schema integrity and the path filter itself always run. `CI complete` fails the workflow if any job that did run failed; skipped jobs are allowed.
2. **Affected lint and type-check.** On a pull request the verify job runs `turbo run type-check lint --filter=...[origin/<base>]`. `main` and other non-PR refs run the same tasks with no filter. Both paths set `NODE_OPTIONS=--max-old-space-size=8192` so the API `tsc` job does not exhaust the default heap under turbo parallelism. Tests stay uncached (`pnpm -r test`, ADR 0100) and the three critical flows (hotel search, contract rate calculation, booking confirmation) run as an explicit Jest step before the full suite.
3. **`deploy.yml` is the merge-to-main ECS Fargate pipeline.** On a successful `CI` run for a push to `main` it builds images and rolls staging (same `aws-images.yml` / `aws-deploy.yml` reusable workflows, same promotion gate, same migration hold). Production is dispatch-only. The pipeline stays inert until `STAGING_PIPELINE_ENABLED=true`. CI still cannot run migrations.
4. **`staging-release.yml` no longer listens for `workflow_run`.** It remains a `workflow_dispatch` alias that calls `deploy.yml`, so existing runbook commands keep working without rolling staging twice.

## Consequences

- Branch protection should require `CI complete` (and, for merge to `main`, the five named release jobs that the AWS promotion gate already lists). A docs-only PR will skip `verify`; that is intentional.
- A `ci.yml` change forces every job, so a broken filter cannot hide a red suite.
- Production remains a person-gated promotion of a SHA that already passed CI and staging (ADR 0040, 0090).

## Rollback

Restore the previous `ci.yml` job list (no `if:` on the expensive jobs) and the echo `deploy.yml`; restore `workflow_run` on `staging-release.yml`.
