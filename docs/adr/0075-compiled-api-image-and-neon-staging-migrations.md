# ADR 0075: Compiled API image and governed Neon staging migrations

Status: Proposed (2026-10-20)

## Context

`Dockerfile.api` installed the whole workspace (dev dependencies included) into `node:24-slim` and started the API with
`node -r @swc-node/register src/main.ts`: every container start transpiled TypeScript, the image carried the compiler, the prisma CLI and every
portal's dependencies, and a type error was only found when CI happened to run `type-check`, never by the image build.

The `@bedbanks/*` workspace packages export TypeScript source (`"exports": "./src/index.ts"`). A plain `tsc` / `nest build` therefore does not fix
the problem: `dist/main.js` would still `require('@bedbanks/contracts')` and load a `.ts` file at runtime.

Migrations: 105 committed migrations, of which the production branch is many behind. They have so far been applied by hand from an owner shell
(docs/runbooks/api-deploy.md) or through a single-release clone certification (`tools/certify-production-clone.mjs`, hard-wired to five migrations).
There is no repeatable rehearsal of "all pending migrations against a copy of production" before production is touched.

## Decision

### Image (`apps/api/Dockerfile`, build context: repository root)

1. `nest build` runs in webpack mode (`apps/api/webpack.config.js`): the `@bedbanks/*` packages are bundled into `dist/main.js`, every npm package
   stays external. The fork-ts-checker pass fails the build on any type error (verified: a deliberate type error exits 1). The builder stage also
   asserts that no `require("@bedbanks/…")` survives in the bundle.
2. Runtime dependencies come from `pnpm deploy --prod --legacy` and are then pruned by reachability (`apps/api/scripts/prune-runtime-deps.cjs`):
   pnpm installs the workspace root's `next`/`react`/`react-dom` and `@prisma/client`'s optional peers (`prisma`, `typescript`) into every deployed
   project; none is reachable from the API. 738 MB → 199 MB of `node_modules`.
3. The Prisma client is generated on Alpine, so the image carries only the `linux-musl-openssl-3.0.x` engine. Alpine already ships `libssl3`; no
   package is added.
4. The runtime stage removes npm, npx, corepack and yarn, keeps application files root-owned and read-only, runs as `node`, and starts
   `node dist/main.js` as PID 1 (`PORT` is mapped to `API_PORT` as before; SIGTERM reaches Node directly for the graceful drain).
5. A second target, `migrator`, carries only the prisma CLI (schema engine fetched at build time), `schema.prisma` and the migrations. The AWS
   one-off migration task uses it (`<sha>-migrate`); the API image can no longer run DDL tooling at all.
6. `@swc-node/register` and `@swc/core` move to `devDependencies`: they serve operator CLIs and local development, never the deployed process.
   `start:prod` is now `node dist/main.js`.
7. The base image is `node:24-alpine` pinned by index digest (engines.node is 24.x; Dependabot's docker ecosystem now also watches `/apps/api`).

### Staging migrations (`scripts/neon-staging-branch.sh`, `scripts/migrate-staging.sh`, `.github/workflows/neon-staging-migrate.yml`)

1. `staging` is a Neon branch of the production branch's head (copy-on-write: production schema, data and roles; no load on production). It is
   reset to production's head before each rehearsal, the previous state preserved under a new name.
2. The owner password inherited by staging is rotated; the runtime login's is rotated by re-provisioning. Staging never holds a production
   credential, and the scripts refuse to issue or use credentials for the protected/default branch or any declared production host.
3. `migrate-staging.sh` is the only path: target guards (direct endpoint, TLS, production denylist, clean tree) → committed chain check →
   history before (unknown, failed, edited, out-of-order, exact pending count) → `prisma migrate deploy` with the owner credential for that one
   command → history after (nothing pending, exactly the pending set applied, in chain order) → `migrate status` → schema drift → runtime role
   re-provision → ownership and forced-RLS audit → no grant drift → runtime login probes. The result is a sanitized evidence JSON whose verdict
   `STAGING_CERTIFIED` and chain digest are the input to a production change request. It never authorizes production by itself.
4. `tools/migration-ledger-check.mjs` checks the committed chain in CI on every change: 12/14-digit UTC IDs, valid dates and times, SQL present,
   lock provider, and no new ID collision. Eight historical collisions (already applied, cannot be renamed) are listed explicitly.
5. Production (`main`) is a Neon protected branch with a point-in-time restore window (default 7 days, `protect`). Each production migration is
   preceded by a compute-less restore-point branch (`restore-point`).

## Consequences

- Image: compressed size 113 MB (runtime) and 104 MB (migrator); cold start no longer pays for TypeScript transpilation. Stack traces point into
  `dist/main.js` (no source maps are shipped).
- `Dockerfile.api` is gone; Render, the AWS image workflow, CODEOWNERS, Dependabot and the runbooks reference `apps/api/Dockerfile`.
- The AWS migrate task definition expects the `-migrate` tag; `ignore_changes = [container_definitions]` means an existing task definition must be
  re-registered once (the AWS foundation has not been applied yet, so nothing live changes).
- 63 of the 105 migration IDs are dated after today: IDs have been used as sequence numbers. The only ordering rule that matters is enforced at
  deploy time: a pending migration may never sort before an applied one. New migrations take the next ID after the highest existing one.
- Neon branch protection does not block DDL. What prevents unreviewed migrations on production is: the owner credential lives only with the owner
  and the reviewed environment, the runtime login cannot run DDL (ADR 0040), and the production runbook requires staging evidence for the same
  chain digest. A Neon API key is project-wide and could read production credentials; it is stored only in the `neon-staging` environment.

## Rollback

Restore `Dockerfile.api` from git and point `render.yaml` / `aws-images.yml` back at it; revert `nest-cli.json` to tsc mode and `start:prod` to the
`@swc-node/register` command; move the two swc packages back to `dependencies`. The staging scripts and workflow are additive and can be deleted.
No database schema changes are part of this ADR.
