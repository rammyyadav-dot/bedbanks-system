# Production schema compatibility — sanitized review report

**PRODUCTION SCHEMA COMPATIBILITY BLOCKED — DO NOT MIGRATE PRODUCTION**

Baseline: `5c19dee520f2b41d8c7226ca6fd93a0e1d238cb9`. Current main was fetched again and is unchanged. Main CI run `36320486868` previously passed. The checkout was clean before the runner changes. This report contains no production endpoint, provider resource identifier, connection string, tenant information or raw query log. GitHub metadata reports this repository as public.

## Reverified database evidence

- Production and the fresh disposable child still have 12 successful migrations. Successful checksums match exact committed SQL SHA-256 values.
- Three unsuccessful historical attempts are formally rolled back and retained. Their two later successful migration records match committed checksums. No migration-history reconciliation or manual SQL was performed.
- Five later migrations remain pending: platform role-management permissions, supplier mapping governance, booking concurrency foundation, authoritative rate amount semantics, and supplier Admin permissions. Exact names and checksums are derived by the runner from the pinned source commit.
- The old certification child has later schema effects without corresponding Prisma history. It is unsuitable for migration-history certification. The newly created child remains at the source baseline.
- Production and fresh-child preflight show no invalid supplier mappings, duplicate mapping keys or invalid availability values. The legacy-rate baseline is unchanged. The new tables and columns are absent on both.
- The provider reports no configured snapshot schedule and no listed snapshots. This does **not** establish whether PITR is enabled: its retention, usable recovery point and restore proof remain unverified.
- The observed owner role has LOGIN and BYPASSRLS and owns the database. The test role is NOLOGIN without bypass. The actual deployed HTTP credential reference remains unverified; owner-role use by HTTP would be a P0 blocker.

## Runner preparation

`tools/certify-production-clone.mjs` and `.github/workflows/clone-certification.yml` prepare a controlled GitHub Actions alternative to the workspace's blocked Neon DNS path. They require separate environment secrets, a recently verified nonprimary/nondefault clone target, the exact application and migration baseline, an explicit clone-write variable, and environment approval configured by the owner. No production credential reference is read.

Target safety checks reject missing secrets, production/default branch identity, pooled endpoints, hostname substitutions, unsafe URL options, TLS downgrade, stale attestations, wrong checksums, unresolved migration failures and partly migrated clones. Only safe aggregate results are published. No raw logs or provider identifiers are included in the artifact.

The environment and clone secrets have **not** been provisioned or verified. The GitHub browser sign-in did not establish an authenticated settings session. The available connector cannot provision environment secrets or dispatch a new workflow. The workflow must remain blocked until that setup is complete.

## Results

| Check | Evidence |
| --- | --- |
| Target guard tests | 7 passed |
| Runner syntax | Passed |
| Missing-secret dry run | Correctly stopped before connecting with `CLONE_SECRETS_MISSING` |
| Earlier unchanged-baseline schema validate/generate, schema guard, type-check, lint | Passed |
| Earlier unchanged-baseline API unit tests | 155 passed, 3 skipped |
| Earlier unchanged-baseline API build | Passed |
| Fresh-clone migration status/deploy/drift | Not certified; no migration executed |
| Clone RLS/tenant isolation, concurrency, commercial, Dubai scale tests | Not run |
| Full application build | Previous run blocked by Google Fonts DNS access |
| Backup/PITR, tested restore, runtime HTTP role, owner release approval | Unresolved |

These local checks validate runner guards only. They do not prove the pending migrations apply successfully to the persistent clone. Database metadata checks and Prisma drift must be evaluated after an actual approved run.

## Next required action

Follow `docs/clone-certification-runner.md` to configure the protected environment and two clone-specific secrets, verify the target attestation, then approve/rerun the clone job. Review its sanitized result and independently recheck history/schema through Neon. A failed or partly migrated child must be inspected and replaced for another certification attempt; never use `migrate resolve` as a shortcut.

Only after all clone, role and recovery gates pass may an exact production change plan be submitted for a separate database-owner approval. No production execution, application deployment, booking activation or PR merge is authorized by this work.

## Continuation — 28 September 2026

- PR #138 was merged into main at `2102b199e05eb405c545c8e117ed114e14478b09`. Both CI runs for its head passed (`36322825570`, `36322840511`). The merged changes touch certification tooling/documentation only; the pinned application and migration baseline is unchanged.
- Clone job `36322825644` ran the seven target/history tests successfully and then stopped at `CLONE_SECRETS_MISSING`. It did not access the database. The published artifact contains a blocked result, not a migration certificate.
- The fresh clone was rechecked: 12 successful migrations, three retained rolled-back attempts, zero unresolved failures. No migration ran during this continuation.
- Found and corrected a post-merge workflow defect: dispatch from `main` was silently skipped because the job allowed only the old review branch. The correction uses a manual dispatch on `main`, removes push triggers, requires an explicit per-run confirmation in addition to the environment gate, and checks configuration before dependency installation. The runner independently enforces GitHub repository/event/ref context. Guard tests now also run in regular CI.
- Protected environment/secret setup remains blocked by GitHub settings authentication. No secret has been committed or printed. Actual clone migration, drift, runtime-role verification and backup/recovery evidence remain unresolved.
