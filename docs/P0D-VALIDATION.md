# P0-D validation and handover

Base: main `e03f8d2d8cfbb34b7d068a3106039743172b2a34`.
Branch: `feat/p0-d-session-hardening`.
Result: application changes verified as below; **P0-D is not complete or deployment-ready**.

## Commands actually run

Commands run from repository root unless specified. DATABASE_URL used for non-database commands was a local placeholder, not a live credential. Runtime: Node 24.19.0, available pnpm 11.19.0 (repository declares pnpm 10.4.1).

| Command | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Passed against base lockfile; Prisma generation run explicitly afterward |
| `pnpm --filter @bedbanks/api prisma:generate` | Passed, Prisma client 6.19.3 |
| `pnpm --filter @bedbanks/api prisma:validate` | Passed |
| `pnpm --filter @bedbanks/api --filter @bedbanks/admin-console type-check` | Passed after final code/test edits |
| `pnpm --filter @bedbanks/api --filter @bedbanks/admin-console lint` | Initially failed: ESLint absent. After adding config/dependencies: passed; one pre-existing unused eslint-disable warning |
| `pnpm --filter @bedbanks/api exec jest --runInBand` | 5 suites, 40 tests passed |
| `pnpm --filter @bedbanks/api exec jest --config test/jest-e2e.json --runInBand auth.e2e-spec.ts` | 5 HTTP integration tests passed; Prisma double, not a real database |
| `pnpm --filter @bedbanks/api test:auth:admin` | 14 tests passed; server-action/API transport integration with mocked fetch and Next cookie/redirect APIs |
| `pnpm --filter @bedbanks/admin-console build` | Passed; existing configuration skips build-time type validation, so separate typecheck was also run |
| `pnpm --filter @bedbanks/api exec tsc -p tsconfig.build.json --outDir /tmp/fbeds-p0d-api-build --incremental false` | Passed; temporary output avoids changing tracked dist files |
| `pnpm --filter @bedbanks/api exec jest --config test/jest-e2e.json --runInBand health.e2e-spec.ts` | FAILED: Prisma cannot connect to localhost:5432; 5 tests blocked at application initialization |
| `pnpm --filter @bedbanks/api exec prisma migrate status` | FAILED: schema engine error with unavailable local PostgreSQL |
| `git diff --check` | Passed |

One initial unit invocation incorrectly passed an extra `--`, so Jest treated `--runInBand` as a test pattern and found no tests. Corrected to the exec command above. Initial config unit tests lacked reflect-metadata; imported it and reran all unit tests successfully. The first Admin build exposed a swallowed Next.js dynamic-rendering signal; moving cookies() outside the API error handler fixed it, with a regression test and successful rebuild.

## Preserved data and migration history

No changes to schema.prisma or any migration SQL; no database writes, migration deployment, seed, reset, db push or migrate dev. The existing P0-C baseline and separate P0-D migration are retained. The third migration repeats their objects, so the chain requires reconciliation before release. See apps/api/prisma/MIGRATIONS.md. No attempt was made to fabricate a replacement repository or schema.

## What remains before completion

1. Obtain a disposable PostgreSQL environment through environment configuration. Never paste live credentials into documentation or chat.
2. Establish whether `202609160001_agent_domain_foundation` has been applied, baselined or failed in any existing environment. Inspect migration history and schema before changing SQL.
3. Reconcile that history, replay from empty, verify drift-free schema, then run real database authentication lifecycle and health integration tests.
4. Run browser E2E over HTTPS: login, dashboard validation, refresh, expiration, logout and replay rejection. The current Admin tests are not browser automation.
5. Configure API ADMIN_ORIGIN and Admin AUTH_API_ORIGIN identically; use API_INTERNAL_URL server-side and Secure cookies. Existing environment overrides must be updated for API port 3002/Admin 3001. Agent uses browser API calls and needs its origin explicitly accommodated in a future multi-origin policy before an Agent rollout; this draft targets Admin. No production deployment or merge performed.

Production abuse protection/rate limiting and full platform-admin authorization are not provided by this patch. Existing tenant-role models were preserved; P0-E is not certified by these authentication checks.
