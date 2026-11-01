# ADR 0090: Staging continuous delivery with owner-run migrations

Status: Proposed (2026-10-25)

## Context

Auditing `.github/workflows` and `infra/aws/terraform` found a strong gate (CI, Docker build and scan, Terraform check, security, tenancy and contract checks,
a promotion gate in `aws-deploy.yml`, a circuit breaker, a rollback workflow) but no connected path from a green `main` to a running staging environment, and
two defects that would each have stopped the first real release:

1. **Image builds could never authenticate.** `aws-images.yml` declared `environment:` on its build job. GitHub then issues the OIDC subject
   `repo:<repo>:environment:<name>`, but the build role trusts only `repo:<repo>:ref:refs/heads/main` (`iam.tf`, enforced by `tools/aws-governance-check.mjs`).
   `configure-aws-credentials` would be denied on every run.
2. **The migration task would re-run the first release.** The ECS migrate task definition is pinned to `var.initial_image_tag-migrate` with
   `ignore_changes = [container_definitions]`, `run-task` cannot override a container image, and the runbook ran the family unmodified. Every later release
   would have reported success while applying nothing new.

The CI deploy role intentionally holds no `ecs:RunTask` and no `iam:PassRole` for the migrate role (ADR 0040, ADR 0055): CI must never be able to read the
database owner credential.

## Decision

1. `aws-images.yml`: the build job has no `environment:`. A credential-free `config` job carries the environment (required reviewers still apply) and passes the
   non-secret variables to `build` as outputs. The build role trust, and the governance check that pins it to `main`, are unchanged. The workflow also
   verifies the commit is on `main` and builds an explicit SHA, so it can be called for the commit CI verified rather than whatever `main` is at run time.
2. `scripts/ecs-migrate.sh <env> <sha>` is the owner-run migration entry point. It resolves `fbeds/api:<sha>-migrate` to a digest, registers a migrate task
   definition revision pinned to it, runs it once with the api service's own subnets and security group, and fails unless the container exits 0.
   Production requires a typed confirmation. It uses the owner's credentials; CI cannot reach it.
3. `staging-release.yml` chains CI success on `main` → images → deploy → smoke test for staging only, calling the existing `aws-images` and `aws-deploy`
   workflows so the promotion gate and environment approval are unchanged. It compares the commit with the last successful staging deployment and, when
   `apps/api/prisma/migrations` changed (or nothing was deployed yet), builds images but holds the deploy and prints the two commands the owner runs next.
   It is inert unless the repository variable `STAGING_PIPELINE_ENABLED` is `true`. The smoke job shows as skipped until `STAGING_SMOKE_URL` is set.
   Production remains manual (`aws-images`, `aws-deploy` with its staging-first gate).

## Consequences

- Nothing here has been run against AWS or GitHub: the AWS foundation is not applied. The first staging run is the verification and its evidence belongs in
  `docs/aws-verification-evidence.md`.
- The migration hold is deliberately conservative: a migration-free commit deploys unattended; any migration needs a person. The cost is one manual step
  per schema change, which is the intended control.
- A deployment whose migration is applied but whose service roll fails leaves the schema ahead of the old code. Migrations stay forward-only and
  backward-compatible with the previous release (`docs/runbooks/rollback.md`).
- Not done, and why: BuildKit layer caching for image builds. A persistent cache needs either a pinned cache action (no SHA could be verified offline) or a
  mutable cache tag, which the immutable ECR repositories forbid. Track as a follow-up.

## Rollback

Set `STAGING_PIPELINE_ENABLED` to anything but `true` to stop the pipeline. The `aws-images.yml`/`aws-deploy.yml` changes are additive (`workflow_call`
alongside `workflow_dispatch`); reverting the commit restores the previous behaviour, including defect 1.
