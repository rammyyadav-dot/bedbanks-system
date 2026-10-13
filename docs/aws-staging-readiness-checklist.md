# AWS staging deployment readiness checklist (WP2)

Nothing here has been run. A tick means "proved by evidence in `docs/aws-verification-evidence.md`", not "implemented". Production DNS, production data, live suppliers, booking and payments are out of scope for staging.

## A. Decisions (owner)
- [ ] Region `ap-south-1` confirmed against supplier connectivity, UAE/India latency, residency and price (ADR 0055).
- [ ] Monthly staging ceiling and alert recipients (`monthly_budget_usd`, `budget_emails`); cost tags activated in Billing.
- [ ] Trusted staging ingress ranges (`public_ingress_cidrs`); staging is never open to the world.
- [ ] Staging account separate from production (or an approved exception).
- [ ] Account audit run and attached (`docs/aws-account-security-checklist.md`).

## B. Foundation (out of band, owner)
- [ ] State bucket (versioned, KMS, public access blocked) and lock table exist and pass the audit.
- [ ] Hosted zone for the staging names exists in Route 53.
- [ ] GitHub environments `staging`/`production` exist; `production` has required reviewers; variables set per runbook.

## C. Pre-apply gates (automatable now; CI runs them)
- [x] `terraform fmt -check`, `validate`, offline `terraform test` (guards refuse open staging, unauthorized production DNS, production without edge or exception).
- [x] `checkov` with a documented baseline; `check:aws-governance`; actionlint.
- [ ] A reviewed `terraform plan` against the real account (needs credentials; the mock plan is not a substitute). Procedure and read-only wrapper: `docs/runbooks/aws-staging-plan.md` (`infra/aws/plan-staging.sh`).
- [ ] The applying human reads the plan: no public data endpoint, no `0.0.0.0/0` in staging, no `create_portal_records` for production.

## D. Apply and deploy (owner, with approval for each step)
- [ ] Phase-1 apply (ECR, OIDC, roles), then images built from `main` (`aws-images`), then phase-2 apply (runbook).
- [ ] Secrets populated out of band; migrate task run as owner with a prior RDS snapshot; migrations forward-only.
- [ ] Runtime roles provisioned (`api-runtime-role.md`, `strict-role-rollout.md`); API boot guard accepts `fbeds_api_login`.
- [ ] `aws-deploy` rolls the five services by **digest** and the stability check passes.
- [ ] `BOOKING_ENABLED` still `false`; no payment or supplier credentials present.

## E. Certification in staging (each needs evidence)
- [ ] Migrations replay cleanly on RDS 16 including `pgvector` and `pg_trgm`; no schema drift.
- [ ] Runtime API cannot bypass tenant RLS (strict-role certification, cross-tenant negative tests).
- [ ] Rate-plan lifecycle role and grants certified.
- [ ] Inventory concurrency (`sold + held <= capacity`) and idempotency tests pass against the RDS instance.
- [ ] Admin, Agent and Supplier browser tests pass against the ECS endpoints; Supplier incomplete workflows remain disabled.
- [ ] Cookie is host-only and `Secure`; redirects use the request Host behind the ALB; CSP/HSTS present; `/api/docs` unreachable from outside the VPC.
- [ ] Connection pools sized against RDS `max_connections` for the task count.
- [ ] Alarms fire (induced test) and reach the subscriber.
- [ ] RDS restore drill into a new instance with recorded timings.
- [ ] Rollback drill: bad image rolled back by the circuit breaker and by redeploying the previous digest.
- [ ] One-week soak with alarms subscribed; cost compared with `docs/aws-cost-model.md`.

## F. Before production is even discussed
- [ ] CloudFront + WAF + origin lock implemented, or an approved written exception (`production_edge_exception_ref`).
- [ ] Portal images promoted by digest (runtime API origin change) or exception recorded.
- [ ] Recorded CTO GO/NO-GO, cutover checklist, rollback authority, `dns_cutover_authorization_ref`.
- [ ] Vercel production left intact.
