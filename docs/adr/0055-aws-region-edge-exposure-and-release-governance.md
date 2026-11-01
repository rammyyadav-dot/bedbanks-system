# ADR 0055: AWS region, edge, exposure and release governance

Status: accepted as the owner's instruction of 2026-10-11 (WP2). Extends ADR 0040; where they differ (region, edge, image promotion) this ADR wins. Nothing has been applied to AWS; no DNS, data or Vercel change is made by this ADR.

## Context
ADR 0040 chose ECS Fargate and left the owner decisions open. The CTO blueprint of 2026-10-11 and the gap analysis (`docs/aws-migration-blueprint-gap-analysis.md`) resolved them. This ADR records those decisions and how the repository enforces them, so they cannot be dropped silently.

## Decisions
1. **Primary AWS Region: `ap-south-1` (Mumbai).** Single region for the MVP, separate staging and production environments. The example tfvars use it. Supplier connectivity, UAE/India latency, data residency and price remain to be confirmed with the AWS Pricing Calculator (`docs/aws-cost-model.md`); a change of region is a tfvars change plus a new ADR. CloudFront-scoped resources (ACM certificate, WAF) will additionally need `us-east-1`.
2. **CloudFront is deferred for staging and required for production.** Production must be CloudFront + WAF in front of an ALB that admits only CloudFront (managed prefix list plus a secret origin header), unless an equally secure alternative is approved in writing. This stack does not implement CloudFront yet, so a production apply is **refused by a Terraform precondition** unless `production_edge_exception_ref` names the approved exception. Implementing the edge is a separate PR.
3. **Staging is private or access-restricted.** The public ALB admits only `public_ingress_cidrs`; a staging plan containing `0.0.0.0/0` is refused (precondition on `aws_lb.public`). Preview and staging URLs are never public; secrets in staging are never production values.
4. **Production DNS cutover is prohibited without authorization.** `create_portal_records` defaults to false, and for production it also requires `dns_cutover_authorization_ref` (the recorded CTO GO). Vercel production stays intact until a separate, explicitly approved retirement. DNS rollback does not reverse database writes (runbook, Cutover).
5. **Immutable digest promotion is mandatory.** The artifact promoted from staging to production is the same image digest, never a rebuild from the same source. Today the four Next.js images bake `API_INTERNAL_URL` and public origins at build time (ADR 0040 decision 4), so this is **not yet satisfied for the portals**. ADR 0056 (WP3) makes Agent, Admin and Supplier environment-neutral (runtime API origin). The website remains the documented exception because its canonical URLs are baked at build time, and its images must not be described as promoted artifacts. Deploys must move to digest references (`repo@sha256:`) as part of that change.
6. **No production booking, payment or supplier integration is enabled implicitly.** `BOOKING_ENABLED=false`, no hold-expiry sweeper, no payment or supplier credentials in Terraform. Enabling any of them needs its own owner decision, secret and verification. The governance check fails CI if the stack's defaults change.
7. **Cost is governed before it is spent.** Environment budgets and mandatory tags (`Project`, `Environment`, `Owner`, `CostCenter`, `Service`, `ManagedBy`) are in Terraform. Thresholds and ceilings are parameters awaiting owner approval; none is invented here. No budget is created while `monthly_budget_usd` is 0.
8. **Account foundations are audited, not assumed absent.** Organizations, IAM Identity Center, CloudTrail and the Terraform state backend live outside this stack. They are checked with a read-only procedure (`docs/aws-account-security-checklist.md`) and never created by this stack. No organization-wide resource is created without explicit authorization.

## Preserved (unchanged by this ADR)
Restricted `fbeds_api_login` runtime role with strict identity check at boot, tenant RLS, the separate owner-only migration task, Secrets Manager/KMS isolation, five independent workloads, fail-closed booking and payments, forward-only migrations never run at container start.

## Consequences
- A production `terraform apply` is blocked until CloudFront exists or an exception is recorded; this is intended friction.
- Staging needs known egress ranges for its testers.
- The portal digest-promotion exception stays on the checklist until the runtime-origin change is made.
- Items found open by static analysis are listed, not hidden, in `docs/aws-verification-evidence.md`.

## Verification
`pnpm check:aws-governance` (static, no AWS) and `terraform test` (mock provider) enforce decisions 2 to 7; see the evidence document for what ran and what is blocked on credentials.
