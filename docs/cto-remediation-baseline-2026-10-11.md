# CTO remediation baseline — 11 October 2026

## Source and branch
Repository: rammyyadav-dot/bedbanks-system (fBeds only; excludes fabBeds/UAEWB).
Observed main: `5e145867c5daaad02b83475c832a78ab72e172ae`.
Audited archive: `bedbanks-system-main (13).zip`.
Archive SHA-256: `b007b4a0367743610340016142ab1213401e01e47951ea7528311641d84d7c2e`.
Archive source identifier matches observed main. GitHub comparison returned identical, 0 ahead, 0 behind, 0 commits and no changed files.
Remediation branch: `fix/cto-audit-remediation-2026-10-11`, created from that exact SHA and verified identical before this documentation commit.
Main and branch were rechecked when the task resumed on 11 October.

The local test source is an extracted archive, not a Git checkout; local branch/working-tree cleanliness is therefore not claimed. No application code was modified. Six relevant local files were independently checked with git hash-object against GitHub blob SHAs at the pinned commit:

| Path | Matching blob SHA |
|---|---|
| CLAUDE.md | 18f7ab89ab008483a0ba20dea221a4d59649cafc |
| apps/api/src/hotel-setup/hotel-quick-update.service.ts | 953ec74d75e494cb391108010db236497130e2fd |
| apps/api/src/database/runtime-db-identity.ts | 80d7bb1dffd0d113cea9e49f8dafee73e679d400 |
| apps/api/src/supply/supply.service.ts | 58145cde9b7aeb174d5728a455af008f55051d1e |
| apps/admin/components/hotels/panels/QuickUpdatePanel.tsx | f4c6f280eddb5a2b9083f8680d69310c462f345d |
| packages/contracts/src/hotel-quick-update.ts | 0eee3d5b2a9de7648a92933ed3a94ede470c19c3 |

This is targeted file verification, not an independent byte-for-byte verification of the entire repository tree.

## Findings carried forward
| ID | Status | Evidence and next acceptance |
|---|---|---|
| F01 | OPEN — confirmed source behaviour | Quick Update replays by key without payload digest comparison. Require identical retry replay and 409 on changed payload. |
| F02 | OPEN — source-backed concurrency risk | Quick Update has its own advisory lock and fingerprint-before-write; other editors use a different protocol. Reproduce with two database connections and establish shared CAS/locking protection. Not a reproduced production incident. |
| F03 | OPEN — confirmed | Quick Update retains only the first 20 changed rows in its audit sample. Persist full before/after details for batches up to the supported limit. |
| F04 | OPEN — confirmed guard coverage gap, exploitability unverified | Effective role flags are checked; differing session principal is name-checked, and membership checks do not cover ordinary application-object owner roles. Verify PostgreSQL SET ROLE reachability and harden accordingly. |
| F05 | OPEN — confirmed state handling | Room/contract filter changes retain selected plan IDs, including hidden selections. Require visible, intentional submitted scope. |
| F06 | OPEN — UX/count semantics | Empty weekdays mean all; success wording uses evaluated record count. This is documented behaviour, not an undisclosed backend bug. Clarify scope and return/display actual changed counts. |
| F07 | OPEN — governance and evidence | Reconcile duplicate ADR 0040 identifiers, stale supplier documentation and historical release reports. Current status information below partially updates the older hosted report but does not establish live acceptance. |

All findings remain because the source is unchanged. F02 and F04 must retain their uncertainty labels until database reproduction; no exploit or lost update was demonstrated in this baseline.

## Baseline checks
Runtime observed: Node v24.19.0.
Repository package manager: pnpm 10.4.1.
Available shell pnpm: 11.25.0 — mismatch recorded, not used to install or modify the lockfile.
Dependencies absent from the archive checkout.

Executed during baseline work:
```sh
node --test tools/clone-certification-guard.test.mjs tools/deployment/config.test.mjs tools/deployment/hosted-agent-smoke.test.mjs
```

Result: 19 passed, 0 failed, 0 skipped, exit 0.
These are local guard/helper tests, not hosted smoke execution.

Not executed: full architecture checks, type-check, lint, full unit/API E2E, builds, migration replay/drift, strict-role database probes, browser journeys or hosted acceptance. No blanket baseline PASS or release certification is asserted. Use the pinned pnpm version and disposable PostgreSQL for the next validation stage.

## Exact-source remote status observation
The combined-status tool reported:

| Context | State |
|---|---|
| Vercel – fbeds-supplier | success |
| Vercel – bedbanks-system-3nc2 | success |
| Vercel – bedbanks-system | success |
| Vercel – fbeds-agent1 | success |
| Vercel – fbeds-agent | failure |

These are commit status contexts, not proof of correct project roots, aliases, runtime API health, authentication or browser acceptance. Failure cause was not inspected.

The workflow-run lookup returned an empty list, but that tool filters to pull-request-triggered runs and the first page. Therefore this does NOT establish absence of push-triggered CI or successful/failed required checks. Complete Actions check-run evidence and branch protection remain unverified.

## Next implementation
1. Add a payload-bound, actor-scoped idempotency contract and durable operation result for Quick Update; preserve existing permissions and tenant context.
2. Reproduce cross-editor conflicts and protect every affected writer consistently.
3. Retain complete immutable per-item change history.
4. Close principal/ownership guard coverage with disposable PostgreSQL probes.
5. Fix selection/count UX; then run full candidate certification.

This branch is a remediation starting point, not a release candidate certified for production.
No production deployment, persistent migration, role provisioning, live supplier request, booking/payment activation or merge was performed.
