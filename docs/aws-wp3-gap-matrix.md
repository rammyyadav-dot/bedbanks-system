# AWS WP3 gap and remediation matrix

Baseline: `origin/main` = `7c317555…` (PR #312 merged); WP3 branch `infra/aws-wp3-staging-hardening`. No open pull requests or issues concerned AWS at the start. No `AGENTS.md` exists at the repository root (per-app `apps/*/AGENTS.md` carry only a Next.js reminder, which was followed: the Next.js docs under `node_modules/next/dist/docs` were read before touching `proxy.ts`).

Status vocabulary: **Verified** = proved by an executed check (named in the evidence report, with its commit); **Partial** = implemented, proof incomplete; **Missing**; **Blocked** = needs AWS credentials, Docker, a staging stack or an owner decision. Nothing is "Verified" because a previous work package said so.

## A. Requirement matrix
| # | Requirement | Existing before WP3 | Status now | Risk | Change in WP3 | Acceptance evidence |
|---|---|---|---|---|---|---|
| 1 | Terraform/workflow CI is green | `ci.yml:167` failed ShellCheck SC2034; actionlint had been "passing" locally only because ShellCheck was absent | Verified locally; CI run on the new head **Blocked until the push is built by GitHub** | High (red CI) | `for _` fix; `tools/workflow-lint.sh` fails without ShellCheck; regression test | `tools/workflow-lint.sh` + 3 tests |
| 2 | Terraform fmt/validate/test/tflint/checkov | WP2: fmt drift, SG cycles, ACM `for_each` defect (fixed in WP2) | Verified | Medium | 17 mock-provider runs, `.tflint.hcl`, checkov baseline split into ACCEPTED/OPEN | evidence §Infrastructure |
| 3 | Redis private, TLS, at-rest encryption, AUTH, secret in Secrets Manager | TLS + at-rest + private; no AUTH | Verified offline; live ElastiCache **Blocked** | High | AUTH token → `REDIS_URL` secret; adapter handshake unit-tested | `terraform test`, governance, 6 adapter tests |
| 4 | VPC flow logs | none | Verified offline | Medium | `aws_flow_log`, KMS log group, scoped role | `terraform test`, governance |
| 5 | ALB access logs, private bucket, lifecycle | none | Verified offline | Medium | S3 bucket (SSE-S3, TLS-only, private, versioned, expiry) on both ALBs | same |
| 6 | WAF logging with redaction | none | Verified offline | Medium | regional + edge ACL logging, `authorization`/`cookie` redacted, BLOCK/COUNT only | same (name-exact assertion) |
| 7 | RDS log exports, Enhanced Monitoring, explicit retention | none | Verified offline | Medium | exports, monitoring role, `log_statement=ddl`, retention groups created first | same |
| 8 | Secrets review, rotation, state vs reference | secret shells; no rotation | Partial | High | `docs/aws-secret-rotation-runbook.md`; CI blocks stray generated secrets/outputs. Automatic rotation of runtime DB URLs **deliberately not done** | governance + runbook; **drill Blocked** |
| 9 | Log retention policy | uniform 30/90 d, RDS logs unlimited | Partial: interim per-class defaults; approval **Blocked on owner** | Medium | `log_retention`, `docs/aws-log-retention-policy.md` | `terraform test` |
| 10 | KMS key usable by CloudWatch; alarms deliver | default key policy; SNS on `alias/aws/sns` (silently drops alarms) | Verified offline; delivery **Blocked** | High | explicit key policy; topic on CMK | governance mutation tests |
| 11 | CloudFront + WAF in front of production | none; production apply refused by a guard | Verified offline; **Blocked** live | High | `edge.tf` (off by default), prefix list + dual-slot origin header, edge ACL, staging IP allow-list, uncached except `/_next/static/*`, headers policy | `terraform test`, governance (22 edge/logging mutations) |
| 12 | Origin cannot be bypassed | public ALB open to the world on 443 | Verified offline; bypass test against a real ALB **Blocked** | High | four layers (ADR 0056 §2) | runbook §6b is the live procedure |
| 13 | Staging access-restricted | ALB CIDR restriction | Verified offline | High | same, plus edge IP allow-list | `terraform test` |
| 14 | Client IP behind CloudFront (rate limiter) | `aws-alb` mode only (would key every visitor to one edge IP) | Verified | Medium | `aws-cloudfront-alb` mode, set by Terraform with the edge | 3 website tests |
| 15 | One image digest across environments | portals bake the API origin | **Verified for agent/admin/supplier as built artifacts**; image digest **Blocked** (no Docker); website **exception** | High | `proxy.ts` runtime proxy, args removed, cache keys independent | 29/29 harness, 7+ unit tests, build-hash tests |
| 16 | SSR, hydration, cookies, tenant context, CSRF unaffected | n/a | Verified for cookie pass-through, body, auth gate, SSR login; browser E2E **Partial** | High | harness covers proxy behaviour; Playwright suites listed in evidence | harness + e2e results |
| 17 | Strict runtime role, RLS, Rate Plan lifecycle, inventory invariants | existing suites | Verified on a disposable PostgreSQL 16 (see evidence for the exact steps/counts) | Critical | no change to DB code, grants or migrations | evidence §Database |
| 18 | CI deploy role cannot run the owner migration | fixed in WP2 | Verified | Critical | regression-locked by governance test | mutation test |
| 19 | OIDC trust restricted to repo/branch/environment | present | Verified statically; deployed role **Blocked** | High | unchanged | governance |
| 20 | No wildcard admin IAM | present | Verified | High | rule made precise (Deny and key-policy root exempt) | governance |
| 21 | Production DNS authorization, CloudFront release guard | present | Verified | Critical | guard now `cloudfront_enabled \|\| approved exception` | `terraform test` |
| 22 | Budget uses owner-approved values | parameter, default 0 | Verified; value **Blocked on owner** | Medium | none | `terraform test` |
| 23 | State backend encrypted, versioned, locked | audit script only | **Blocked** (account access) | High | none | `infra/aws/audit/account-audit.sh` |
| 24 | Live-account staging checks (Organizations, Identity Center, CloudTrail, quotas, restore, alarms…) | procedures only | **Blocked**: no credentials were available or authorised | n/a | none; nothing fabricated | evidence §Blocked |

## B. The eight open security findings from WP2
| Finding | Status | Evidence / next action |
|---|---|---|
| ElastiCache AUTH (CKV_AWS_31) | **REMEDIATED** offline: static + mock + adapter tests. Staging connection test **BLOCKED** (needs a real replication group) | next: apply to staging after plan review, run the cache-hit check in runbook §6 |
| VPC flow logs (CKV2_AWS_11) | **REMEDIATED** offline; first-log-delivery check **BLOCKED** | next: confirm streams appear in `/fbeds/<env>/vpc-flow` |
| ALB access logs (CKV_AWS_91) | **REMEDIATED** offline; delivery **BLOCKED** | next: confirm objects under `alb/` after the first requests |
| WAF logging (CKV2_AWS_31) | **REMEDIATED** offline (regional + edge); delivery and redaction on live traffic **BLOCKED** | next: send a blocked test request, inspect one record for `authorization`/`cookie` redaction |
| RDS Enhanced Monitoring (CKV_AWS_118) | **REMEDIATED** offline | next: confirm OS metrics in CloudWatch |
| RDS log exports (CKV_AWS_129) | **REMEDIATED** offline | next: confirm `postgresql` stream receives connection/DDL lines |
| Secret rotation (CKV2_AWS_57) | **BLOCKED**: manual rotation documented, not drilled; an automatic least-privilege rotation function needs design | next: drill procedures A to C in staging; owner decides on a rotation function |
| 1-year log retention (CKV_AWS_338) | **BLOCKED** on the owner: no retention requirement supplied; interim per-class defaults shipped | next: owner states per-class requirement, then set `log_retention` |

Accepted risks: every `ACCEPTED` row in `docs/aws-checkov-exception-register.md` is **PROPOSED**; none is an approved acceptance until the owner signs it (owner, date and expiry columns are blank by design).
