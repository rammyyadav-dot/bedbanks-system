# Hosted release certification audit — 2026-10-06

**HOSTED RELEASE CERTIFICATION: BLOCKED**

## Source and frozen database

Source: `fix/hosted-release-certification`, main `89ec4c5dad8b9a8ba383830cac36a729c13ae39a`, tree `38bd4f028395189fc1d652ab7ee3ac66c415e68b`. Node v24.19.0; pnpm 10.4.1. The isolated worktree was clean before evidence edits.

Since certified main `a2bc9dd767d31f70c4ddd6f4a2b6cbbe54b556cf`, commits `b63947ceceae8855bd89945dc3e3e551968a439e` and `89ec4c5dad8b9a8ba383830cac36a729c13ae39a` change only three booking specification documents. No application, database, permission or deployment code changed. DATABASE_CERTIFICATION=PASS is retained as frozen evidence; database certification was not rerun locally, and no new database regression was observed from the diff.

## Vercel topology

Team: `rammyyadav-4259s-projects` / `team_Nq9NAggwlwknWiH5chkDqACv`.

| Project | Access | Root | Deployment evidence |
|---|---|---|---|
| bedbanks-system | Accessible, Next.js, Node 24.x | Not exposed by connector; effective website confirmed by HTTP | READY production `dpl_359TPHiuFY9TstxfLeqY7owXfz57`, main SHA `6a4a326797ac5c72227d8ebab0ffeb050bd766f6` |
| fbeds-agent | BLOCKED: lookup 404 | Unverified; required apps/agent | Current-main GitHub deployment status rate-limited |
| fbeds-agent1 | BLOCKED: lookup 404 | Unverified; required apps/agent | Current-main failed status points to `dpl_7zayZKnn4z6LwbofhX6e6nwandFf`; cause not readable |
| admin | BLOCKED: lookup 404 | Unverified; required apps/admin | No certified deployment |
| fbeds-supplier | BLOCKED: lookup 404 | Unverified; required apps/supplier | Current-main GitHub deployment status rate-limited |

The scoped project list returns only bedbanks-system. A 404 cannot distinguish an absent project from a scope restriction. Do not create duplicates on this evidence.

| Alias | Project/deployment ownership evidence |
|---|---|
| fbeds-agent.vercel.app | bedbanks-system / dpl_359TPHiuFY9TstxfLeqY7owXfz57 |
| fbeds-admin.vercel.app | Same website project/deployment |
| fbeds-hotel-supplier.vercel.app | Same website project/deployment |
| www.fbeds.com | Ownership not returned by scoped connector; unchanged |

Project domains and production deployment alias metadata corroborate the three incorrect app aliases. Filtered alias-list calls returned empty results, so they are not used to contradict deployment metadata.

Current-main statuses report “Deployment rate limited — retry in 24 hours” for bedbanks-system, bedbanks-system-3nc2, fbeds-agent and fbeds-supplier. This establishes the reported build quota blocker; it does not prove obsolete projects or bad roots. No deployment retry, deletion or paid upgrade was attempted.

Only environment **names and targets** were inspected with decrypt=false. Website production includes database/hold-sweep names; seed names and API/ROOT variants also appear. API_INTERNAL_URL is absent from this visible website project's list. This is not evidence of environment configuration in inaccessible Agent projects. No values were printed or changed.

## HTTP and hosted acceptance

Direct read-only HTTP checks:

| Request | Result |
|---|---|
| https://fbeds-api.onrender.com/api/v1/health | 404; x-render-routing: no-server |
| https://fbeds-api.onrender.com/api/v1/health/ready | 404; x-render-routing: no-server |
| https://fbeds-agent.vercel.app/login | 200; Sign in to fBeds; canonical https://www.fbeds.com/login |
| https://fbeds-agent.vercel.app/platform | 200; Hotel distribution platform; canonical https://www.fbeds.com/platform |

API_RUNTIME=BLOCKED for the documented API candidate. The effective upstream in inaccessible deployed Agent/Admin configuration is unverified. AGENT_ALIAS=WRONG_APPLICATION. These are mandatory stop conditions. No authenticated hosted/browser smoke, mutations or fixture seeding were attempted. Hotel browser acceptance, Agent Dubai search/pagination/recheck states, hosted strict-role identity, tenant context and server-side authorization remain NOT_VERIFIED. No approved hosted test account or certified fixture/runtime was established. HTTP checks are not browser acceptance evidence.

## CI and governance

Exact-main CI run [37406326523](https://github.com/rammyyadav-dot/bedbanks-system/actions/runs/37406326523) was in progress at observation. Schema integrity and Website production checks passed. In verify, frozen install, client generation, type-check and lint passed; unit tests/builds were not yet complete. Prisma migration certification passed its initial strict-login/RLS probes and targeted hotel step; full e2e/final recertification were pending. Portal deployment configuration run 37406326496 passed. No unfinished step is recorded as PASS.

Branch protection returned 403 Resource not accessible by integration. Rulesets returned []. REQUIRED_CHECK_SET=UNVERIFIED_ACCESS_BLOCKED. No governance changes made. Visible canonical candidate checks include Schema integrity, Prisma migration certification, verify, Website production checks, and Portal deployment configuration; the actual required set must be read by an authorized administrator.

## F01

F01 remains OPEN. The original archive checksum is verified, but it matches the inspected parent ffc7e34078c3cffb3495ae7ff9ca76fb7a7b2667 rather than pinned aea042299bdc2b7fbc33945b0cb89ba0a7a04238. Exact-candidate full Node24 validation and required-check enforcement remain unresolved. See the authoritative correction in release-candidate-source-certification.md. Neither candidate nor release authorization was changed.

## Validation and changes

`node --test tools/deployment/config.test.mjs tools/deployment/hosted-agent-smoke.test.mjs`: 8/8 PASS on Node24. These cover hosted URL fail-closed validation, portal rewrites and smoke failure behavior; they do not establish a live API or hosted acceptance. Full local API/Admin/Agent/build suites were not rerun for this documentation-only change. Frozen certified-main evidence remains: API unit 818, e2e 575, targeted hotel 180, builds 14.

Only this audit document and the F01 correction changed. No runtime fix can be justified until project scope and hosted infrastructure are available.

## Remaining release blockers and recommendation

1. Scoped access to dedicated projects/settings, correct root/build/environment evidence and build quota recovery.
2. Authoritative hosted API readiness, strict-role runtime evidence and approved isolated test accounts/fixtures.
3. Separate READY Agent/Admin deployments and real browser acceptance; Agent alias cutover requires certification and explicit approval.
4. Actual required-check enforcement evidence.
5. F01 archive mismatch resolution and exact-candidate validation.

**NOT READY FOR OWNER-CONTROLLED PERSISTENT ROLLOUT.** Database certification remains frozen PASS; hosted infrastructure and acceptance are blocked.

```ini
PRODUCTION_DB_MIGRATION_EXECUTED=NO
PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO
PRODUCTION_DEPLOYMENT_EXECUTED=NO
DNS_OR_ALIAS_CHANGED=NO
LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO
BOOKING_ENABLED_BY_THIS_WORK=NO
PAYMENT_ENABLED_BY_THIS_WORK=NO
PR_MERGED_BY_THIS_SESSION=NO
RELEASE_AUTHORIZATION_GRANTED=NO
```
