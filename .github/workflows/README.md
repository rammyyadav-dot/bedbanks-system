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
- `deploy.yml` is a manual deployment gate. It does not deploy automatically; provider-specific deployment configuration remains separate.

## Reading a failure as a non-programmer

Open the pull request, select **Checks**, and open the red **CI** job. The first red step is the actionable failure. Copy that step's error output into Cursor/Claude Code or send it to the engineering owner. Do not treat a later skipped step as a second fault: it did not run because CI intentionally stopped at the first failure.
