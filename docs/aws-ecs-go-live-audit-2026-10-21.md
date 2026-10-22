# AWS ECS production cutover: CTO scan, audit and report (2026-10-21)

Scope: ECS Fargate task definitions, ALB routing rules, Neon PostgreSQL production replicas, and production go-live readiness. Method: read the actual Terraform, workflows, runbooks, ADRs and scripts; ran the offline checks that can run here. **No AWS or Neon API call was made and nothing was provisioned.** Production remains **NO-GO** (it was NO-GO in `docs/aws-wp3-release-readiness.md`; nothing below changes the owner-side blockers).

## Decision (2026-10-22)
Owner instructed: follow the recommendation. **RDS is the production primary; no Neon replicas** (ADR 0079, accepted). Data moves by logical replication from Neon (runbook, Cutover step 2). Findings 1, 6 and 8 below are addressed by this decision and the wording fix; the rest remain open.

## Verdict
| Item | Status | Evidence |
|---|---|---|
| ECS Fargate task definitions | **Already built, unproven.** | `ecs.tf`: 5 services (api, admin, agent, supplier, website) + one-off `migrate` task; awslogs to KMS-encrypted groups, execution vs per-service task roles, circuit breaker with rollback, CPU autoscaling (min = desired, max 4x), `enable_execute_command=false`, `BOOKING_ENABLED=false` default. Task definitions are Terraform-owned for revision 1 only; CI registers later revisions. |
| ALB routing rules | **Already built, unproven.** | `alb.tf`: public ALB (host-header rules agent/admin/supplier/website, 404 default, HTTP to HTTPS redirect, TLS 1.3 policy, WAF with managed rules + rate limit, optional `X-Origin-Verify` condition behind CloudFront); internal ALB for the API reachable only from portals; API health `/api/v1/health/ready`. |
| Neon production replicas | **Not built before this change; provisioning script added; no consumer.** | See ADR 0079. Production database is designed as RDS, not Neon: the request conflicts with the accepted architecture and needs an owner decision. |
| Production go-live | **NO-GO.** | See blockers. |

## Findings
1. **High, decision: database provider conflict.** ECS stack provisions RDS; production data is on Neon. Cutover plan = dump/restore with a point of no return. "Neon replicas" only make sense if Neon stays primary. ADR 0079 lays out both options; owner must choose. Mixed primaries are refused.
2. **High, fixed: CI was red for any PR touching `infra/aws` or `tools/aws-*`.** `tools/aws-governance-check.test.mjs` pinned a `configure-aws-credentials` SHA (v4.3.1) that Dependabot had since moved to v6.3.0, so the "long-lived AWS keys" mutation test failed with "fixture drift" (46/47 passed). The fixture now matches any pinned SHA. 56/56 pass.
3. **High, open: no application path to a replica.** One `DATABASE_URL`, one Prisma client. Forced RLS, per-request tenant context and replication lag make this a design task (ADR 0079), not a config flag. A replica today is idle capacity and not a capability.
4. **Medium, open: replicas are not disaster recovery.** Neon replicas share primary storage. DR = PITR window + restore-point branches (`protect`, `restore-point`), which the runbook already covers. Confirm the plan's retention (7 days Launch, up to 30 Scale) meets the owner's RPO.
5. **Medium, open: Terraform cannot be validated here.** The Terraform registry returns 403, so `init`, `validate`, `test` (mock provider), checkov and tflint did not run. Terraform 1.9.8 itself downloaded fine. CI (`terraform-check.yml`) runs them; a reviewed real `terraform plan` is still the gate. Do not treat the stack as verified.
6. **Medium, open: stale text.** `variables.tf`/`production.tfvars.example` and the runbook still say the stack "does not implement CloudFront yet", but `edge.tf` (393 lines) implements it. The production precondition therefore reads as a hard block when `cloudfront_enabled = true` would satisfy it. Reconcile the wording after the staging edge test passes.
7. **Medium, open: portal digest promotion.** The website image still bakes canonical URLs at build time (ADR 0056 exception), so ADR 0055 #5 (promote the same digest) is not met for it.
8. **Low:** the migrate task image tag derives from `initial_image_tag` (`<tag>-migrate`); with the default `bootstrap` the first start fails. The new preflight refuses `bootstrap` for production.
9. **Low:** API health grace is 120 s; the API is now compiled (ADR 0075), so measure startup in staging and tighten.

## What I built (small, reviewable, no AWS/Neon calls)
- `tools/aws-golive-preflight.mjs` (+ tests, wired into `terraform-check.yml`, `pnpm golive:preflight <tfvars>`): 12 static gates over the operator's untracked production tfvars (real zone id, CloudFront or recorded exception, Multi-AZ DB, NAT per AZ, 2+ tasks, pinned commit image, owner-approved budget + recipients, alarm subscriber, booking off, DNS only with recorded CTO GO). The shipped example correctly fails 5 gates.
- `scripts/neon-staging-branch.sh replica-create|replica-status`: idempotent read-only compute on the production branch, no secrets printed; ShellCheck added to CI for this script. Exercised against a stubbed REST API only.
- Fixed the stale governance test fixture (finding 2).
- ADR 0079 (proposed).

## Go-live gate list (in order; owners in brackets)
1. ~~Decide ADR 0079~~ done: RDS primary. Still owner-side: confirm Neon plan supports logical replication and an IP allowlist, and the RPO for RDS backups (14 days now).
2. Run `infra/aws/audit/account-audit.sh`; resolve FAIL/UNKNOWN [owner].
3. Create state backend; staging ingress CIDRs; budget ceiling and recipients; activate cost tags [owner].
4. Run CI `Terraform check` green; read a real `terraform plan` for staging [engineer + CTO].
5. Phase-1 apply (ECR/OIDC), build images, phase-2 apply, secrets, migrate task, runtime roles, smoke test [runbook steps 1 to 6].
6. Staging soak of at least one week; restore, rotation and edge-bypass drills (`docs/aws-staging-readiness-checklist.md` E) [engineer].
7. For Neon primary: `protect`, `restore-point`, allowlist NAT EIPs, measure latency from `ap-south-1`; for replicas: design and ship the read path first.
8. `pnpm golive:preflight production.tfvars` passes; production plan reviewed; CTO GO recorded as `dns_cutover_authorization_ref` [CTO].
9. Cutover per runbook; keep Vercel unaliased 14 days.

## Sign-off (blank until given)
Decision: ____  Name: ____  Date: ____
