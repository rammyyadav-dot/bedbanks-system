# fBeds GitHub workflows

GitHub Actions is the automated quality gate for this repository. It runs in GitHub's own temporary computer whenever code is pushed or a pull request is opened or updated.

## `ci.yml` — the main quality gate

`CI` runs on every push to every branch and on every pull request. It checks every workspace under `apps/*`, `packages/*`, and `packages/connectors/*`.

It does the following in order:

1. Downloads the submitted code and prepares Node.js 24 and pnpm 10.4.1.
2. Installs the exact dependency versions recorded in `pnpm-lock.yaml`. A lockfile problem fails here.
3. Starts a temporary PostgreSQL 16 database for the API. This database is empty and disposable; it is not the production database.
4. Generates Prisma's database client and applies the committed Prisma migrations. A migration failure means the database change cannot be safely applied to a blank PostgreSQL database.
5. Runs TypeScript type checks in every app and package. A broken type, missing import, or incompatible API contract fails here.
6. Runs lint checks. A lint failure means code violates the repository's static quality rules.
7. Runs tests. API end-to-end tests boot the NestJS application against the real temporary PostgreSQL database; the database integration test writes and reads a tenant record. Other workspaces run their available test discovery command.
8. Builds every app and package. A build failure means a deployable app or package cannot be produced.

The commands run in this order and GitHub stops the job at the first failure. There is no `continue-on-error`: a red CI result must be investigated before merge.

## Other workflows

- `contract-check.yml` verifies that declared NestJS controller paths exist in the shared API contracts.
- `tenancy-check.yml` runs tenant-context authorization coverage.
- `docker-build.yml` builds every shipped image (api runner, api migrator, four portals) without pushing, lints the Dockerfiles, checks the images run as non-root, scans them with Trivy (fixable HIGH/CRITICAL fail), and uploads a CycloneDX SBOM. Runs on PRs that touch image inputs, on main, and weekly (ADR 0086).
- `staging-release.yml` is the staging pipeline (ADR 0090): CI green on main → images for that commit → deploy → smoke test. Inert until the repository variable `STAGING_PIPELINE_ENABLED` is `true`. If migrations changed it builds but holds the deploy; the owner runs `scripts/ecs-migrate.sh staging <sha>` and re-dispatches with `migrations_applied=true`. CI never holds migration credentials.
- `aws-images.yml` / `aws-deploy.yml` are the manual entry points (production uses them directly) and are also called by the staging pipeline. The image build job intentionally has no `environment:` so its OIDC subject matches the main-only build role.
- `aws-rollback.yml` is the manual, environment-gated way to put one ECS service back on an earlier task definition revision (`docs/runbooks/rollback.md`).
- Every job must declare `timeout-minutes`; `tools/workflow-permissions-check.mjs` enforces it.
- `deploy.yml` is a manual deployment gate. It does not deploy automatically; provider-specific deployment configuration remains separate.

## Reading a failure as a non-programmer

Open the pull request, select **Checks**, and open the red **CI** job. The first red step is the actionable failure. Copy that step's error output into Cursor/Claude Code or send it to the engineering owner. Do not treat a later skipped step as a second fault: it did not run because CI intentionally stopped at the first failure.

## `security.yml` and `contract-check.yml` — security and database-safety gates

`security.yml` runs on every pull request and every branch push, plus weekly. Its jobs:

- **Dependency audit** — fails on any unaccepted high or critical production advisory (`security/audit-allowlist.json` holds reviewed, expiring exceptions) and on any action not pinned to a full commit SHA, floating runner image, missing `permissions` block or missing job timeout.
- **CodeQL** — `security-extended` queries for JavaScript and TypeScript.
- **Secret scan** — gitleaks with `.gitleaks.toml`. Pull requests and branch pushes scan only the commits they add; `main`, tags and the weekly run scan the full history. A rule self-test fails the job if the custom rules stop detecting synthetic secrets. A failure lists rule, file, line and commit in the job summary (never the secret) and says to rotate first.

`contract-check.yml` runs when apps, packages, tools, security data or the lint config change:

- **API contracts** (`pnpm check:contracts`).
- **Raw SQL gate** (`pnpm check:raw-sql`, `eslint.config.mjs`) — values must reach PostgreSQL as bind parameters. `$queryRawUnsafe`, `$executeRawUnsafe` and `Prisma.raw` are confined to the audited files in `security/raw-sql-baseline.json` (DDL and role administration); the count per file only ratchets down. A new site needs `// raw-sql: <reason>` after review.
- **Prisma migration safety** (`pnpm check:migration-safety`) — every foreign-key field needs a leading index (existing gaps are baselined in `security/migration-safety-baseline.json`), and migrations a PR adds are checked for drops, type changes, `SET NOT NULL`, renames, unbounded `UPDATE`/`DELETE`, blocking index builds on existing tables and credential literals. A reviewed exception is `-- migration-safety: allow <rule> <reason>` above the statement.

Gate failures are echoed into the job summary with a "how to fix" line (`tools/ci-step-summary.sh`).
