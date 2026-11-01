# AWS WP2 verification evidence (2026-10-11)

Status key: **PASS** = executed here with the output described. **FAIL** = executed and failing. **OPEN** = a known gap, not a pass. **BLOCKER** = cannot run without AWS credentials or live infrastructure; the exact procedure is given. **Nothing in this document certifies the AWS environment.** No `terraform apply`, no AWS API call, no DNS change, no database access, no deployment was performed.

## Baseline
- Start of WP2: branch `claude/wizardly-feynman-qu6rm0` at `fbf822d` (on `d9244e4`, on merge `846b2bf`), working tree clean. There is no `AGENTS.md` in the repository; `CLAUDE.md` (the constitution) and `.agents/skills` (Neon material, unrelated) were read instead.
- Tools (sandbox): Terraform 1.9.8 (same as CI), AWS provider 6.68.0 from a local mirror (the Terraform registry is blocked by the sandbox proxy; `releases.hashicorp.com` was reachable), checkov 3.2.0, actionlint 1.7.7, Node 22 (repo wants 24).
- **Defects found in the existing stack before any WP2 change** (the committed `terraform-check.yml` would not have passed on them):
  1. `terraform fmt -check` failed on `dns.tf`, `ecr.tf`, `ecs.tf`, `secrets.tf`.
  2. `terraform validate` failed: dependency cycles between security groups (`alb_public`/`portal`; `alb_internal`/`api`/`data`).
  3. A first plan would fail with "Invalid for_each argument": the ACM validation records were keyed on apply-time values.
  4. The CI deploy role lacked the ECR permissions `aws-deploy.yml` uses (it would fail with AccessDenied), and could `RunTask` the owner-credential migration task.
  ADR 0040 only claimed that the HCL parses; these are why.

## Results
| Check | Result | Evidence |
|---|---|---|
| `terraform fmt -check -recursive` | **PASS** | exit 0 after fixes 1 |
| `terraform init -backend=false` + `terraform validate` | **PASS** | "The configuration is valid" (fixes 2) |
| `terraform test` (mock AWS provider, `command = plan`, 8 runs) | **PASS** 8/8 | staging restricted plans; staging `0.0.0.0/0` refused; production without edge exception refused; production DNS without authorization refused; budget needs recipients; budget plans with recipients; no budget by default; empty cost tag refused. Whole stack plans under the mock, which also exercised fix 3 |
| `checkov` 3.2.0, `.checkov.yaml` baseline | **PASS** (230 passed, 0 failed) with **OPEN** items | 27 findings before: 1 fixed (default security group, CKV2_AWS_12), 10 ACCEPTED with a reason, 8 OPEN listed below. Skipped checks are not passes |
| `node tools/aws-governance-check.mjs` | **PASS** | region, six mandatory tags, staging exposure, budget default 0, DNS default off, booking off, OIDC trust pins, no wildcard IAM, no apply/keys in workflows, ADR 0055 present |
| `node --test tools/aws-governance-check.test.mjs` | **PASS** 14/14 | each rule is proven to fail when broken (mutation tests on a temp copy) |
| `pnpm check:architecture` | **PASS** | exit 0, includes `check:aws-governance` and the runtime database role check (736 files, 16 audited client sites) |
| actionlint on all workflows | ~~PASS~~ **INCOMPLETE (corrected in WP3)** | it reported no findings, but ShellCheck was not installed, so actionlint skipped the analysis of every `run:` script. With ShellCheck it reports SC2034 at `.github/workflows/ci.yml:167` (fixed in WP3; `tools/workflow-lint.sh` now fails when ShellCheck is missing) |
| Budget configuration validation | **PASS** (static, offline) | mock-plan tests above; the real `aws_budgets_budget` API call is **BLOCKER** below |
| Resource-tagging check | **PASS** (static) | provider `default_tags` carry the six keys; per-service overrides on ECR, ECS service/task definition, log groups, target groups. Actual tags on deployed resources: **BLOCKER** |
| IAM / OIDC trust-policy check | **PASS** (static) | `StringEquals` on `aud` and exact `sub`; build role main-only, deploy role environment-bound; deployed trust: **BLOCKER** |
| `pnpm type-check`, `lint`, `test`, app builds | **NOT RUN** | no application code changed (only `infra/`, `tools/`, `docs/`, workflows, `.gitignore`, `package.json` script); CI will run them |
| Shell lint of `account-audit.sh` | **PARTIAL** | `bash -n` passes, fails closed with exit 2 without credentials; `shellcheck` not installed; the script has never run against AWS |

## OPEN findings (visible, not hidden by the baseline)
VPC flow logs (CKV2_AWS_11), WAF logging (CKV2_AWS_31), secret rotation (CKV2_AWS_57), Redis AUTH/RBAC (CKV_AWS_31), ALB access logs (CKV_AWS_91), RDS enhanced monitoring (CKV_AWS_118), RDS log exports (CKV_AWS_129), 1-year log retention (CKV_AWS_338). Also OPEN from the gap analysis: CloudFront not built; portal images are not promotable by digest; no detective services (GuardDuty, Security Hub, Config).

## BLOCKERS and exact procedures
| Blocked check | Needs | Procedure |
|---|---|---|
| Real `terraform plan` | AWS credentials, state backend, hosted zone | `terraform -chdir=infra/aws/terraform init -backend-config=...`, `plan -var-file=<untracked env file> -out=plan.bin`, then `terraform show -json plan.bin` and review: no public RDS/Redis, no `0.0.0.0/0` in staging, tags on every taggable resource, no DNS records for production. A human reads it before any apply. |
| Account audit (Organizations, Identity Center, CloudTrail, state backend, OIDC roles) | read-only AWS identity | `infra/aws/audit/account-audit.sh ap-south-1 <state-bucket> <lock-table> [trail-bucket]`; attach the output here; any `FAIL`/`UNKNOWN` is a finding |
| Budgets in effect and alerts delivered | owner-approved ceiling, tags activated in Billing | set `monthly_budget_usd`/`budget_emails`, apply, confirm the budget in the console, trigger a test alert; verify the six tags appear in Cost Explorer |
| Pricing | AWS Pricing Calculator for `ap-south-1` | replace `PRICES` in `tools/aws/cost-model.py`, re-run, update `docs/aws-cost-model.md` |
| Image build, ECS start, ALB health, redirect Host behaviour | Docker, AWS | runbook steps 2 to 6 in staging |
| RLS / strict-role / concurrency / idempotency on RDS 16 | staging database | runbook steps 4 and 5, then the certification scripts in `docs/runbooks/strict-role-rollout.md` and the existing API e2e suites pointed at staging |
| Restore and rollback drills | staging stack | `docs/aws-staging-readiness-checklist.md`, section E |
| Digest deploy (`aws-deploy.yml` change) | staging | run *AWS deploy*; confirm the task definition image is `repo@sha256:` and the stability check passes |

## Strict stop conditions
Not violated: no `terraform apply`, no billable resource, no DNS change, no production data access, no live supplier integration, booking and payment flags unchanged (`BOOKING_ENABLED=false`, guarded), Vercel and Render untouched. Terraform `init`/`validate`/`test` ran only against a mocked provider.

## Honest limits
The mock-provider plan proves our own conditions and wiring, not that AWS will accept the configuration (instance class availability in `ap-south-1`, quota, `pgvector` support in the chosen RDS minor version, WAF/ACM behaviour). Those need the real plan and a staging apply.
