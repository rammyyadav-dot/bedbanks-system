# Remote branch review (report only, 2026-10-01)

Base: `origin/main` @ `6b587a8372561cdedd466e88ea6f61dc55d9f16b`. 124 remote branches inspected (excluding `main`). **Nothing was deleted or modified.** Open PRs on the repository at inspection time: **0** (GitHub API, state=open).

Method: `git merge-base --is-ancestor <tip> origin/main` for merge evidence; `git cherry origin/main <tip>` to count commits whose patch is not already in `main`; merge PR numbers from `Merge pull request #N from <owner>/<branch>` commits on `main`. Squash-merged branches would show as unmerged here, so "unmerged" below means *needs a human look*, not *safe to discard*.

## A. Cleanup candidates: tip already in `main` (85)

Safe in the sense that no commit would be lost; an owner should still confirm no one needs the ref name. Open-PR status: none open.

| Branch | Last commit | Age (days) | Author | Merge evidence |
|---|---|---|---|---|
| `feat/p0-c-prisma-postgresql` | 2026-09-09 | 22 | Claude (FBEDS build assistant) | PR #12 (merge 0c48ac184) |
| `v0/fix-date-range-selection` | 2026-09-10 | 21 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `fix/env-examples-and-setup` | 2026-09-14 | 17 | Claude (FBEDS build assistant) | PR #31 (merge c52783db0) |
| `feat/p0-d-session-hardening` | 2026-09-16 | 15 | Codex | PR #37 (merge ce0b4343f) |
| `feat/ci-pipeline` | 2026-09-16 | 15 | Codex | PR #39 (merge 739e5f255) |
| `restore/p0-complete` | 2026-09-16 | 15 | Codex | PR #26 (merge 8e5357927) |
| `feat/supplier-extranet-ui` | 2026-09-16 | 15 | rammyyadav-dot | PR #41 (merge 5ed134465) |
| `v0/agent-domain-foundation` | 2026-09-16 | 15 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `fix/prisma-single-source` | 2026-09-16 | 15 | rammyyadav-dot | tip is an ancestor of main (no merge-PR commit found) |
| `feat/enterprise-foundation` | 2026-09-16 | 15 | Codex | PR #38 (merge 6430bb6d4) |
| `feat/website-production-readiness` | 2026-09-17 | 14 | rammyyadav-dot | PR #44 (merge 359a3cc2b) |
| `feat/release-blocker-guardrails` | 2026-09-17 | 14 | vercel[bot] | tip is an ancestor of main (no merge-PR commit found) |
| `v0/admin-console-backend-dashboard-bb9b4daa` | 2026-09-17 | 14 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `feat/supplier-route-structure` | 2026-09-17 | 14 | rammyyadav-dot | PR #43 (merge e6566ba27) |
| `feat/postgres-release-controls` | 2026-09-18 | 13 | rammyyadav-dot | PR #54 (merge e0f63ba00) |
| `feat/supply-domain-foundation` | 2026-09-18 | 13 | rammyyadav-dot | PR #56 (merge 1dc9e99e4) |
| `v0/audit-public-website` | 2026-09-18 | 13 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `fix/supplier-booking-route-conflict` | 2026-09-18 | 13 | rammyyadav-dot | PR #51 (merge 59fda260a) |
| `feat/supplier-supply-onboarding-ui` | 2026-09-18 | 13 | rammyyadav-dot | PR #59 (merge e74206195) |
| `feat/prisma-tenant-finance-hardening` | 2026-09-18 | 13 | rammyyadav-dot | PR #53 (merge d3d4d8321) |
| `fix/revert-unintended-supplier-main-files` | 2026-09-18 | 13 | rammyyadav-dot | PR #61 (merge 363a585f0) |
| `fix/prisma-migration-certification` | 2026-09-18 | 13 | rammyyadav-dot | PR #50 (merge 87b9daa5a) |
| `v0/admin-console-backend-dashboard-35a3f467` | 2026-09-20 | 11 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `v0/admin-rbac-authorization-ux` | 2026-09-20 | 11 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `test/p0e-final-security-certification` | 2026-09-21 | 10 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `v0/admin-console-backend-dashboard-dfe4e01a` | 2026-09-22 | 9 | v0 | tip is an ancestor of main (no merge-PR commit found) |
| `feat/admin-room-master-authoritative` | 2026-09-23 | 8 | rammyyadav-dot | PR #68 (merge 3395b59f5) |
| `feat/supplier-mapping-governance` | 2026-09-23 | 8 | rammyyadav-dot | PR #69 (merge a28d53c22) |
| `fix/hold-outcome-type-boundary` | 2026-09-26 | 5 | rammyyadav-dot | PR #95 (merge 7e10095f9) |
| `fix/post-merge-authoritative-recheck-certification` | 2026-09-26 | 5 | rammyyadav-dot | PR #94 (merge 5cecea63f) |
| `test/inventory-concurrency-certification` | 2026-09-26 | 5 | rammyyadav-dot | PR #98 (merge a0efe7aa0) |
| `fix/redis-ci331-typecheck` | 2026-09-26 | 5 | rammyyadav-dot | PR #92 (merge f40338e7d) |
| `feat/authoritative-rate-amount-semantics` | 2026-09-26 | 5 | rammyyadav-dot | PR #87 (merge abe8a6000) |
| `fix/inventory-concurrency-hardening` | 2026-09-26 | 5 | rammyyadav-dot | PR #99 (merge 6166c4960) |
| `feat/agent-authoritative-rate-recheck` | 2026-09-26 | 5 | rammyyadav-dot | PR #93 (merge 3cd0099f3) |
| `test/hold-release-concurrency-certification` | 2026-09-26 | 5 | rammyyadav-dot | PR #100 (merge efab482d5) |
| `feat/rate-rules-cancellation-foundation` | 2026-09-26 | 5 | rammyyadav-dot | PR #96 (merge 104878eb5) |
| `feat/admin-daily-rate-bulk-sellability-mvp` | 2026-09-27 | 4 | rammyyadav-dot | PR #128 (merge f9b944ead) |
| `fix/clone-certification-runner` | 2026-09-27 | 4 | rammyyadav-dot | PR #138 (merge 2102b199e) |
| `test/admin-dubai-operations-acceptance` | 2026-09-27 | 4 | rammyyadav-dot | PR #130 (merge 167055520) |
| `feat/admin-rate-plan-mvp` | 2026-09-27 | 4 | rammyyadav-dot | PR #123 (merge 4aa722e6b) |
| `feat/supplier-prebook-orchestration` | 2026-09-27 | 4 | rammyyadav-dot | PR #112 (merge d9187010a) |
| `fix/pr110-conflicts` | 2026-09-27 | 4 | rammyyadav-dot | PR #111 (merge 7ec4ac14a) |
| `fix/admin-inventory-money-safety` | 2026-09-27 | 4 | rammyyadav-dot | PR #134 (merge f72b7839d) |
| `fix/post-merge-prebook-recovery-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #115 (merge 57f48c0f0) |
| `docs/persistent-db-reconciliation-2026-09-27` | 2026-09-27 | 4 | rammyyadav-dot | PR #137 (merge 5c19dee52) |
| `fix/post-merge-booking-finance-audit-fixture` | 2026-09-27 | 4 | rammyyadav-dot | PR #109 (merge 13ee262b0) |
| `fix/post-merge-inventory-money-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #135 (merge b56a80587) |
| `fix/final-board-basis-e2e-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #119 (merge 24a2c0521) |
| `feat/admin-rate-inventory-operations-mvp` | 2026-09-27 | 4 | rammyyadav-dot | PR #126 (merge 382284803) |
| `fix/post-merge-inventory-race-test-import` | 2026-09-27 | 4 | rammyyadav-dot | PR #105 (merge 96d01147f) |
| `fix/post-merge-inventory-route-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #127 (merge ff2372b64) |
| `test/dubai-seven-day-stop-sell-matrix` | 2026-09-27 | 4 | rammyyadav-dot | PR #132 (merge 9ebb08545) |
| `feat/admin-dubai-rate-inventory-console` | 2026-09-27 | 4 | rammyyadav-dot | PR #129 (merge 2bbe78f89) |
| `feat/booking-transaction-state-machine` | 2026-09-27 | 4 | rammyyadav-dot | PR #106 (merge a289914e8) |
| `fix/post-merge-rate-plan-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #125 (merge 4eea0951c) |
| `fix/post-merge-booking-finance-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #108 (merge f4dfa44a2) |
| `feat/dubai-mvp-commercial-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #136 (merge 71f501476) |
| `fix/post-merge-contract-policy-bigint` | 2026-09-27 | 4 | rammyyadav-dot | PR #122 (merge 6d5442643) |
| `test/inventory-hold-release-race-certification` | 2026-09-27 | 4 | rammyyadav-dot | PR #104 (merge 690e5f388) |
| `docs/persistent-db-inventory-evidence` | 2026-09-27 | 4 | rammyyadav-dot | PR #133 (merge a1783726f) |
| `fix/admin-dubai-acceptance-typecheck` | 2026-09-27 | 4 | rammyyadav-dot | PR #131 (merge 92450de4a) |
| `feat/canonical-offer-lifecycle` | 2026-09-28 | 3 | rammyyadav-dot | PR #141 (merge dd008f7c6) |
| `fix/clone-certification-dispatch` | 2026-09-28 | 3 | rammyyadav-dot | PR #139 (merge c44e1637e) |
| `test/dubai-commercial-100-hotel-acceptance` | 2026-09-28 | 3 | rammyyadav-dot | PR #140 (merge c218d6dd4) |
| `fix/p0-release-gate-closure` | 2026-09-29 | 2 | rammyyadav-dot | PR #146 (merge e78d748a7) |
| `feat/agent-canonical-search-ux` | 2026-09-29 | 2 | rammyyadav-dot | PR #145 (merge c16154ec5) |
| `fix/dubai-contract-boundary-regression` | 2026-09-30 | 1 | rammyyadav-dot | PR #147 (merge 7ac5eabf3) |
| `fix/hold-expiry-regression` | 2026-09-30 | 1 | Claude | PR #151 (merge 5846a9411) |
| `fix/hold-expiry-role` | 2026-09-30 | 1 | Claude | PR #153 (merge 40bc37e4a) |
| `chore/agent-remove-demo-data` | 2026-09-30 | 1 | Claude | PR #159 (merge 5b6369cb6) |
| `fix/ops-password-diagnosis` | 2026-09-30 | 1 | Claude | PR #161 (merge 01471a24b) |
| `fix/ops-preflight-resolved-history` | 2026-09-30 | 1 | Claude | PR #155 (merge f943bc49a) |
| `release/dubai-mvp-rc1` | 2026-09-30 | 1 | rammyyadav-dot | PR #150 (merge 7acb92ac3) |
| `fix/dubai-mvp-p0-release-hardening` | 2026-09-30 | 1 | Claude | PR #149 (merge b3258a862) |
| `feat/hold-expiry-ops-workflow` | 2026-09-30 | 1 | Claude | PR #154 (merge fb10feed4) |
| `cursor/agent-search-pagination-runtime-8eb9` | 2026-10-01 | 0 | Claude | PR #166 (merge 0e2d498b8) |
| `cursor/strict-tenant-public-env-8eb9` | 2026-10-01 | 0 | rammyyadav-dot | PR #168 (merge cce2019d6) |
| `cursor/blank-vercel-root-8eb9` | 2026-10-01 | 0 | Cursor Agent | PR #182 (merge 07124bc85) |
| `cursor/hybrid-mapping-search-cache-8eb9` | 2026-10-01 | 0 | Cursor Agent | PR #172 (merge 1d3f7d748) |
| `feat/agent-portal-ux` | 2026-10-01 | 0 | rammyyadav-dot | PR #158 (merge 51b06c7e9) |
| `cursor/website-root-directory-8eb9` | 2026-10-01 | 0 | rammyyadav-dot | PR #183 (merge 965d15099) |
| `feat/tenant-settings` | 2026-10-01 | 0 | rammyyadav-dot | PR #156 (merge db8e92029) |
| `cursor/authoritative-dubai-agent-search-8eb9` | 2026-10-01 | 0 | Claude | PR #162 (merge 8270cf968) |
| `cursor/supplier-extranet-foundation-8eb9` | 2026-10-01 | 0 | Cursor Agent | PR #186 (merge 6b587a837) |

## B. Ahead of `main` but every commit's patch already exists in `main` (10)

Likely rebased or cherry-picked. Verify, then they join list A.

| Branch | Last commit | Age | Author | Commits ahead | Note |
|---|---|---|---|---|---|
| `feat/scaffold-agent-app` | 2026-09-09 | 22 | Claude (FBEDS build assistant) | 1 | no merge-PR commit found |
| `feat/agent-search-cache-foundation` | 2026-09-26 | 5 | rammyyadav-dot | 1 | PR #90 merged from this branch earlier; later commits unmerged |
| `test/ledger-financial-safety-certification` | 2026-09-26 | 5 | rammyyadav-dot | 2 | PR #101 merged from this branch earlier; later commits unmerged |
| `fix/post-merge-board-basis-normalization` | 2026-09-27 | 4 | rammyyadav-dot | 1 | PR #118 merged from this branch earlier; later commits unmerged |
| `feat/admin-commercial-rate-inventory-mvp` | 2026-09-27 | 4 | rammyyadav-dot | 5 | PR #116 merged from this branch earlier; later commits unmerged |
| `fix/post-merge-admin-commercial-certification` | 2026-09-27 | 4 | rammyyadav-dot | 2 | PR #117 merged from this branch earlier; later commits unmerged |
| `feat/admin-contract-policy-mvp` | 2026-09-27 | 4 | rammyyadav-dot | 1 | PR #120 merged from this branch earlier; later commits unmerged |
| `feat/prebook-compensation-recovery` | 2026-09-27 | 4 | rammyyadav-dot | 2 | PR #113 merged from this branch earlier; later commits unmerged |
| `fix/hold-expiry-sweep` | 2026-09-30 | 1 | Claude | 1 | PR #152 merged from this branch earlier; later commits unmerged |
| `cursor/vercel-website-app-root-8eb9` | 2026-10-01 | 0 | Cursor Agent | 1 | PR #180 merged from this branch earlier; later commits unmerged |

## C. Contains commits not in `main`: DO NOT DELETE without review (28)

| Branch | Last commit | Age | Author | Commits ahead | Patch-unique commits | Note |
|---|---|---|---|---|---|---|
| `feat/nest-api-scaffold` | 2026-09-07 | 24 | rammyyadav-dot | 24 | 22 | no merge-PR commit found |
| `feat/create-backend-api` | 2026-09-07 | 24 | rammyyadav-dot | 20 | 18 | no merge-PR commit found |
| `feat/scaffold-api-app` | 2026-09-07 | 24 | rammyyadav-dot | 20 | 18 | no merge-PR commit found |
| `feature/scaffold-apps-api` | 2026-09-07 | 24 | rammyyadav-dot | 20 | 18 | no merge-PR commit found |
| `feat/monorepo-foundation` | 2026-09-07 | 24 | rammyyadav-dot | 16 | 15 | no merge-PR commit found |
| `feat/scaffold-admin-app` | 2026-09-09 | 22 | Claude (FBEDS build assistant) | 2 | 1 | no merge-PR commit found |
| `feat/p0-b-nestjs-api-foundation` | 2026-09-09 | 22 | Claude (FBEDS build assistant) | 1 | 1 | no merge-PR commit found |
| `feature/admin-console-ui` | 2026-09-10 | 21 | Claude (FBEDS build assistant) | 2 | 1 | no merge-PR commit found |
| `feat/p0-d-authentication` | 2026-09-12 | 19 | Claude (FBEDS build assistant) | 1 | 1 | no merge-PR commit found |
| `fix/api-auth-prisma-structure` | 2026-09-13 | 18 | Claude (FBEDS build assistant) | 3 | 3 | no merge-PR commit found |
| `feat/schema-divergence-guard` | 2026-09-16 | 15 | Codex | 1 | 1 | PR #40 merged from this branch earlier; later commits unmerged |
| `docs/postgres-production-go-no-go` | 2026-09-18 | 13 | rammyyadav-dot | 7 | 7 | no merge-PR commit found |
| `fix/p0-database-schema-integrity` | 2026-09-19 | 12 | v0 | 1 | 1 | no merge-PR commit found |
| `refactor/agent-portal-domain-components` | 2026-09-24 | 7 | rammyyadav-dot | 31 | 27 | no merge-PR commit found |
| `feat/agent-portal-transactional-foundation` | 2026-09-24 | 7 | rammyyadav-dot | 19 | 17 | no merge-PR commit found |
| `fix/agent-portal-lint-after-74` | 2026-09-24 | 7 | rammyyadav-dot | 31 | 26 | no merge-PR commit found |
| `feat/agent-canonical-search-offers` | 2026-09-25 | 6 | rammyyadav-dot | 59 | 46 | no merge-PR commit found |
| `feat/admin-dashboard-api` | 2026-09-25 | 6 | rammyyadav-dot | 44 | 38 | no merge-PR commit found |
| `v0/agents-search-portal-5a4ea5ae` | 2026-09-25 | 6 | v0 | 54 | 42 | no merge-PR commit found |
| `feat/booking-concurrency-foundation` | 2026-09-25 | 6 | rammyyadav-dot | 63 | 48 | no merge-PR commit found |
| `fix/admin-dashboard-post-merge` | 2026-09-25 | 6 | rammyyadav-dot | 44 | 37 | no merge-PR commit found |
| `feat/verified-supply-bindings` | 2026-09-25 | 6 | rammyyadav-dot | 61 | 47 | no merge-PR commit found |
| `feat/ledger-financial-safety` | 2026-09-26 | 5 | rammyyadav-dot | 2 | 1 | PR #97 merged from this branch earlier; later commits unmerged |
| `feat/supplier-recheck-hold-boundary` | 2026-09-26 | 5 | rammyyadav-dot | 65 | 49 | no merge-PR commit found |
| `fix/post-merge-ledger-race-recovery` | 2026-09-26 | 5 | rammyyadav-dot | 1 | 1 | PR #102 merged from this branch earlier; later commits unmerged |
| `feat/agent-offer-hold-ui` | 2026-09-26 | 5 | rammyyadav-dot | 67 | 50 | no merge-PR commit found |
| `test/dubai-offer-lifecycle-acceptance` | 2026-09-28 | 3 | rammyyadav-dot | 1 | 1 | PR #142 merged from this branch earlier; later commits unmerged |
| `fix/admin-transport-hardening` | 2026-10-01 | 0 | rammyyadav-dot | 2 | 2 | PR #157 merged from this branch earlier; later commits unmerged |

## Active branches excluded from candidates

`claude/charming-goodall-0jo555` (reused for earlier PRs; its work is merged) and `claude/website-release-safety` (this change).

