# AWS migration blueprint: gap analysis against the repository (2026-10-11)

Compares the CTO "Vercel to AWS" blueprint of 11 October 2026 with what is committed: ADR 0040, `infra/aws/terraform`, `Dockerfile.api`, `Dockerfile.web`, `.github/workflows/aws-*.yml` and `docs/runbooks/aws-ecs-deployment.md`.

**Status of everything below: committed code only. No `terraform plan`, image build, ECS start or AWS resource has been exercised** (the runbook says the same). `terraform-check.yml` runs `fmt` and `validate` only.

## Already covered by the repository

| Blueprint item | Where |
|---|---|
| Separate ECS service, task role, scaling and health check per app (website, agent, admin, supplier, api) | `ecs.tf`, `iam.tf`, `alb.tf` |
| Private subnets for tasks, data tier with no internet route, two AZs, S3 gateway endpoint | `network.tf` |
| Host-based ALB routing, HTTPS (TLS 1.3 policy), HTTP to HTTPS redirect, ACM, internal ALB for the API | `alb.tf`, `dns.tf` |
| WAF (managed rules plus per-IP rate limit) on the public ALB | `alb.tf` |
| RDS PostgreSQL 16, encrypted (KMS), force SSL, Multi-AZ switch, 14-day backups, deletion protection and final snapshot in production, owner password in Secrets Manager | `data.tf` |
| ElastiCache Redis with TLS and at-rest encryption | `data.tf` |
| Non-root multi-stage images, immutable ECR tags (commit SHA), scan on push | `Dockerfile.*`, `ecr.tf` |
| GitHub OIDC build and deploy roles, main-only build, environment-gated deploy | `iam.tf`, `aws-images.yml`, `aws-deploy.yml` |
| ECS deployment circuit breaker with a post-deploy check that the rollback did not silently win | `ecs.tf`, `aws-deploy.yml` |
| Migrations never run at container start; separate one-off migrate task as owner; forward-only | `ecs.tf` (`migrate`), runbook step 4 |
| Runtime role contract (no superuser, no BYPASSRLS, owns nothing) enforced by the API at boot | ADR 0040 (runtime identity guard), `docs/runbooks/api-runtime-role.md` |
| No workers deployed; booking and hold-expiry sweeper off by default | `variables.tf` (`BOOKING_ENABLED=false`) |
| DNS records created only after an explicit flag; Vercel stays live | `dns.tf` (`create_portal_records=false`) |
| No RDS Proxy (blueprint: only after verifying tenant session context) | not present, correct |

## Gaps and conflicts (owner decisions marked **D**)

1. **No CloudFront.** The blueprint puts CloudFront + WAF in front of the ALB and restricts the ALB so the edge cannot be bypassed. Today the WAF is on a public ALB that is reachable directly by its AWS name. Adding CloudFront needs: a CloudFront-scoped WAF (us-east-1), the managed CloudFront prefix list on the ALB security group plus a secret origin header rule, cache behaviours that never cache authenticated or `/api/v1` responses, and a check that the host-only Secure cookie and the redirect `Location` host still hold. **D:** is CloudFront required for the MVP, or is the WAF-on-ALB topology acceptable until traffic justifies it? Needs an ADR either way.
2. **Image promotion conflicts with blueprint section 5.** The portals bake `API_INTERNAL_URL` and the public origins into the Next.js build (rewrites are generated at build time), so `aws-images.yml` builds per environment and the same digest cannot go from staging to production. Fixing this means reading the API origin at runtime (a small, separate, reviewed change to the four `next.config` files and `tools/deployment/api-url.mjs`). Until then, state the exception in the CTO checklist rather than claiming "same digest".
3. **Cost governance** (partly addressed on this branch: `budgets.tf`, `Owner`/`CostCenter` tags). Still **D:** the approved monthly ceiling per environment, and activating the cost-allocation tags in Billing.
4. **Account-level controls are out of band.** Organizations, IAM Identity Center, CloudTrail and the Terraform state bucket are not in this stack. **D:** confirm they exist or add a separate bootstrap stack.
5. **NAT cost.** Only the S3 endpoint exists; ECR, Logs and Secrets Manager traffic crosses NAT. The runbook already flags interface endpoints; price them against NAT with the calculator before adding.
6. **Region.** Example tfvars use `eu-central-1` (inherited from the Render blueprint); the blueprint suggests `ap-south-1`. **D:** decide on supplier connectivity, UAE/India latency, data residency and price. It changes the CloudFront/WAF/ACM layout and tfvars only.
7. **Redis hardening.** TLS and at-rest encryption are set; I found no `auth_token` or RBAC user group, and snapshot retention is 1 day. Redis holds search cache only (not the booking ledger), so this is a hardening item, not a blocker.
8. **Certification gates not started.** Nothing yet proves: migration replay on RDS with pgvector/pg_trgm, strict-role grants, RLS bypass tests, inventory concurrency and idempotency tests against the AWS database, browser tests against ECS staging, restore drill, rollback drill. These are the checklist items that matter and need real staging infrastructure.
9. **API starts from TypeScript source** via `@swc-node/register` (larger image, 120 s health grace). Acceptable for staging; revisit before production.
10. **Fonts at build time.** `agent-portal` fetches Google Fonts during build; fine on GitHub runners.

## Recommended next steps (smallest reviewable units, in order)

1. Owner decisions **D** on items 1, 3, 4 and 6; ADR 0055 recording CloudFront and region.
2. Cost guardrails PR: budgets, cost tags, approved ceiling in tfvars examples.
3. Runtime API origin PR (item 2), so one digest can be promoted.
4. Backend + state bucket, then staging apply per the runbook, then the certification gates in item 8.
5. CloudFront PR, only after step 1 says yes.
6. Production DNS cutover stays a separate, explicitly approved step.

Nothing here changes application behaviour or enables booking, payment or supplier workflows.
