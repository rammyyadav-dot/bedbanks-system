# AWS WP3 verification evidence

Status key: **PASS** = executed, exit 0, counts quoted. **FAIL** = executed and failing. **NOT RUN** = not executed. **BLOCKED** = cannot run here (no AWS credentials, no Docker, no staging stack, or an owner decision); the exact procedure is given. Nothing below is claimed on the strength of an earlier work package.

**Commits.** Base `origin/main` `7c317555…` (PR #312). Offline infrastructure checks, the website job and the portal harness ran at **`a337df8589aa44ef72a6faad682eae3995e09984`** (branch head when the checks were run; later commits add only this evidence document and the release-readiness note). The database certification, type-check, lint, package tests and builds ran at **`2eb9a7a95dab55cf81a021bbdbfbd7ef7cb14722`** plus the then-uncommitted `apps/api/src/common/cache/redis-cache.adapter.auth.spec.ts`, committed in `b69dc92`; `git diff 2eb9a7a..a337df8 -- apps packages Dockerfile.* turbo.json package.json` shows that one added test file and nothing else, so application and database code are identical at both.

**Environment (differs from CI).** Node 22.22.0 (the repo wants 24; pnpm warns), PostgreSQL 16.15 from Ubuntu with pgvector **0.6.0** (CI uses the newer `pgvector/pgvector:pg16` image), Redis 7.0.15 from Ubuntu (CI uses `redis:7-alpine`), Terraform 1.9.8 with AWS provider 6.68.0 and random 3.9.1 from a local mirror (the registry is blocked by the sandbox proxy), checkov 3.2.0, tflint 0.54.0, actionlint 1.7.7, ShellCheck 0.11.0. The disposable database was a loopback-only cluster created for this run and deleted afterwards; the repository's certification script insists on `GITHUB_ACTIONS=true` and `GITHUB_ENV`, which were **emulated** locally while its own checks of host (`127.0.0.1`), database (`fbeds_ci`) and `NODE_ENV=test` still ran. No production database or AWS account was touched.

## 1. Phase 2: CI and actionlint
| Check | Result |
|---|---|
| Reproduce the reported failure | **PASS (reproduced)**: `actionlint` with ShellCheck reports `.github/workflows/ci.yml:167:9 … SC2034: i appears unused` |
| Fix (`for _ in $(seq 1 40)`) | **PASS**: behaviour identical, the variable was never read |
| `tools/workflow-lint.sh` (actionlint 1.7.7 + ShellCheck 0.11.0) over all 10 workflows | **PASS**: clean |
| Regression test: unused loop variable rejected; `_` accepted; lint refuses to pass without ShellCheck | **PASS** 3/3 |
| GitHub Actions run on the final PR head | **PASS**, see §7 (it failed once on the first head for a test-isolation bug of mine, fixed in `1bf2e33`) |

## 2. Infrastructure (at `a337df8`)
| Check | Result |
|---|---|
| `terraform fmt -check -recursive` | **PASS** |
| `terraform init -backend=false` + `validate` | **PASS** |
| `terraform test` (mock providers; guards and plan-level properties) | **PASS** 17 runs, 0 failed. 7 targeted mutations of the logging/edge assertions were applied to confirm the tests bite; 6 failed as intended and the 7th exposed (and led to fixing) a weak assertion |
| `tflint` 0.54.0 (core ruleset, recommended preset) | **PASS** exit 0 |
| `checkov` 3.2.0 with `.checkov.yaml` | **PASS** 319 passed, 0 failed (skips are in the register, not passes) |
| `check:aws-governance` | **PASS** |
| governance mutation tests | **PASS** 46/46 |
| `pnpm check:architecture` (contracts, no-float, no-silent-fallback, public env, runtime DB role, AWS governance) | **PASS** |
| Mock-provider caveat | Cache-policy wiring cannot be asserted through the mock (unknown ids compare vacuously true); it is enforced statically and mutation-tested in the governance check instead |

## 3. Runtime API origin and image promotion (Phase 5, at `a337df8`)
| Check | Result |
|---|---|
| Resolver unit tests (`runtime-api-proxy.test.mjs`): two environments, dot-segment and encoded escapes, authority injection, hosted fail-closed, local default | **PASS** 7/7 |
| Config tests (no `rewrites`, proxy uses the resolver, explicit `/api/v1` matcher, no `NEXT_PUBLIC` in proxies) | **PASS** (deployment tests 19/19 incl. hosted-agent smoke) |
| Turbo build hash **independent** of `API_INTERNAL_URL`, `AUTH_API_ORIGIN`, `AUTH_COOKIE_NAME`, `SUPPLIER_ORIGIN`; **dependent** on the website's public variables | **PASS** 11 assertions |
| Build each portal once, with **no** API/auth/origin variable set, as a standalone server | **PASS** admin, agent, supplier |
| `certify-runtime-origin.mjs`: same artifact run as configuration A and B against two backends; POST body and cookie forwarded; `Set-Cookie` returned host-only/Secure/HttpOnly; dotted paths proxied; escape attempts 404 and never reach the backend; hosted + HTTP/loopback origin → 503 with a fixed code, `no-store`, and no backend call; Admin anonymous redirect to `/login` and SSR `/login` 200; artifact tree unchanged after both runs | **PASS 29/29** (agent 9, admin 11, supplier 9). Artifact tree digests of this run: agent `f77b93a654d49e1e6beea39f32823fdd7e5986a3e3c08a075e48d8739ff7094b`, admin `612dc48d9e1a1548ee29dd3e1edc182f9aff3fc0a2fcb162e9d0d829d47ecf06`, supplier `80a1f684e085fbc647ea88866fbbc4eff76b0d1eea0f29bcc19aab08bdffd864`; builds are not bit-reproducible, so digests differ between builds |
| Container **image digest** equality in two environments | **BLOCKED**: no Docker daemon. Procedure: `docker buildx build -f Dockerfile.web --build-arg APP=<app> --build-arg PACKAGE=<pkg>` once, push, run it with two different `API_INTERNAL_URL` values (https, non-loopback), compare `docker inspect --format '{{.Id}}'` and the registry digest; runbook §6c |
| Website | **EXCEPTION, not a pass**: canonical URLs are baked at build time (`NEXT_PUBLIC_*`) |
| Admin/Agent/Supplier **browser** regression tests | **MISSING in the repository** (`e2e/` is a documented placeholder; only the website has Playwright). The harness above covers the proxy, cookie and auth-gate behaviour at HTTP level. Not reported as passing |

## 4. Application (at `2eb9a7a` + `b69dc92` spec)
| Check | Result |
|---|---|
| `pnpm type-check` (all 14 tasks) | **PASS** |
| `pnpm lint` | **PASS**: 0 errors; 1 pre-existing warning in `apps/api/src/inventory/inventory-admin.service.ts:59` (unused disable directive, not touched here) |
| `pnpm -r --if-present test` (CI `verify` command, with Redis) | **PASS** exit 0. API unit **103 suites / 1,087 tests**; API e2e 79 of 80 suites / **733 tests**, 18 skipped (the skipped suite is `tenant-control.e2e-spec.ts`, which self-skips without extra role URLs and is covered by the certification below); node-test packages **331 tests, 0 failed** (admin 90, agent 107, supplier 4, website 62, connectors/core 32, domain 28, money 4, pricing 4) |
| `pnpm -r --if-present build` | **PASS** (agent needed `NODE_EXTRA_CA_CERTS` for the sandbox's TLS-inspecting proxy; CI does not) |
| Website job as CI defines it (type-check, lint, unit, build, `check:site`, Playwright) | **PASS**; Playwright **48/48** |
| Redis AUTH-token compatibility: 6 unit tests against an in-process RESP server (4 fail when AUTH sending is removed) | **PASS** 6/6 |
| Same adapter integration spec against a real Redis 7.0.15 with `requirepass`: with the token / without / wrong token | **PASS** 3/3 / refused 3/3 / refused 3/3. **TLS + AUTH on real ElastiCache: BLOCKED** |

## 5. Database and financial safety (Phase 6, at `2eb9a7a`; disposable PostgreSQL 16.15 + pgvector 0.6.0)
| Check | Result |
|---|---|
| `prisma validate` / `generate` | **PASS** |
| Migration replay (`migrate deploy`: **66** migrations applied from an empty database, including `vector` and `pg_trgm`), `migrate status` ("Database schema is up to date"), `migrate:drift` | **PASS**; drift re-checked after all suites: **No schema drift** |
| Disposable-target + strict login + forced RLS certification (`fbeds_api_login`: not superuser, no BYPASSRLS, owns nothing) | **PASS** before and again after all suites |
| Hotel acceptance suites (strict-role runtime HTTP, commercial, workflows, replay, inventory recheck/pool lifecycle, strict-role rollout) | **PASS** 12 suites / **195 tests** |
| Sandbox staging strict-role acceptance | **PASS** 4/4 |
| Full API e2e (includes tenant isolation, rate-plan lifecycle, booking/inventory concurrency and idempotency suites) | **PASS** 79 suites / **733 tests** (twice: standalone run and CI-`verify` run) |
| Tenant-control certification (`ops:certify-tenant-control`, distinct restricted roles) and preview DI smoke | **PASS** |
| No change to schema, migrations, grants, roles, pricing, supplier mapping, booking, payment or hold code in WP3 | **Verified by diff** (`git diff origin/main..HEAD --stat -- apps/api/prisma apps/api/src` shows only the added test spec) |
| Production database | **Not touched** |

## 6. Phase 8: live-account checks. All BLOCKED (no AWS credentials were available or authorised)
| Item | Procedure to close it |
|---|---|
| Organizations / account separation; Identity Center; CloudTrail and detective services; state backend (encryption, versioning, lock) | `infra/aws/audit/account-audit.sh <region> <state-bucket> <lock-table> [trail-bucket]` with a read-only identity; attach output |
| Budgets and cost-allocation tags | owner sets `monthly_budget_usd`/`budget_emails`; activate the six tags in Billing; confirm a test alert |
| ECS/Fargate, ALB, NAT, EIP, RDS, ElastiCache quotas in the target region and account | `aws service-quotas list-service-quotas` for each service; compare with the plan (note the ~55-rule CloudFront prefix list against the security-group rule quota) |
| RDS PostgreSQL 16 minor version and `vector`/`pg_trgm` availability in `ap-south-1` | `aws rds describe-db-engine-versions --engine postgres --engine-version 16 --region ap-south-1` and `CREATE EXTENSION` during the migrate task |
| ECR repositories, ALB + CloudFront routing, Secrets Manager entries and IAM access | reviewed `terraform plan`, then staging apply (owner approval), then runbook §6 and §6b |
| RDS restore capability; CloudWatch alarm notification delivery | restore a snapshot to a new instance and record timings; induce an alarm and confirm the SNS email |
| Real `terraform plan` / apply | reviewed by a human before any apply; this branch applied nothing |

## 7. GitHub Actions results (read from GitHub, 2026-10-12)
PR #314 was merged into `main` (merge commit `702dad8057cffe6114e5170e1cf45f6245e474a6`) about one minute after the last push, **before the long jobs had finished**; the results below were read afterwards. The merge was not made by the assistant.

| Workflow / job | `5052114` (first PR head) | `1bf2e33` (final PR head) | `702dad8` (merge on `main`) |
|---|---|---|---|
| Terraform check (`validate`: fmt, init, validate, `terraform test`, governance, checkov, workflow lint) | **FAILED** run #4: only the *Workflow lint* step, a bug in my own regression test (it limited `PATH` to `/usr/bin:/bin`, where runners keep ShellCheck, so the lint ran and the test wrongly expected exit 2). All earlier steps passed on the runner | **PASS** run #5 | not triggered (the workflow runs on pull requests that touch `infra/aws/**`, tools or workflows) |
| CI: Schema integrity (incl. `check:architecture`, `check:aws-governance`) | pass | **PASS** | **PASS** |
| CI: Website production checks (incl. Playwright) | pass | **PASS** | **PASS** |
| CI: Prisma migration certification (hotel/strict-role suites, sandbox acceptance, full API e2e, drift, re-certification) | not read (superseded) | **PASS** (about 11 minutes) | **PASS** |
| CI: verify (tenant-control certification, DI smoke, `pnpm -r` type-check/lint/test/build with Redis) | not read (superseded) | **PASS** (about 11 minutes) | **PASS** |
| Contract checks | pass | **PASS** | n/a |
| Tenant isolation checks | pass | **PASS** | n/a |
| Portal deployment configuration (incl. build-hash independence) | pass | **PASS** | **PASS** |

Consequence: the Phase 2 acceptance ("Terraform CI succeeds on the exact new commit, not merely in the local environment") is **met for `1bf2e33`**, and the repository's own CI (including the database certification and the full test run on GitHub's runners with Node 24) passed on both the final PR head and the merge commit on `main`. For the jobs CI runs, these results narrow the sandbox caveats in the Environment note above: they ran on Node 24 with the CI service images (`pgvector/pgvector:pg16`, `redis:7-alpine`) and with the real `GITHUB_ACTIONS` variables. Checks CI does not run (the two-backend portal harness, the Redis `requirepass` run, the account-level items) are unchanged. Vercel preview builds of the portals (Agent previews reached DEPLOYED with the new `proxy.ts`) were observed in PR comments but are not part of this table.

## 8. Resources created in AWS
**None.** No `terraform apply`, no AWS API call, no DNS change, no production data access, no live supplier, booking or payment activation, no Vercel or Render change.
