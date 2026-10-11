# AWS environment cost model (WP2)

**Not a quote.** Prices in `tools/aws/cost-model.py` are unverified us-east-1 list prices recalled from memory; they are **not** `ap-south-1` prices and are **not** from the AWS Pricing Calculator. Use the figures to compare scenarios and to find what dominates cost, not to set a budget. Replace the `PRICES` table with Calculator values (or pass `--uplift`) and re-run `python3 tools/aws/cost-model.py --markdown`. Taxes, support plan, Savings Plans, free tier, data transfer between AZs and RDS backup storage beyond the free allotment are excluded.

**No ceiling is proposed here.** `monthly_budget_usd` and `budget_alert_thresholds` are Terraform parameters awaiting owner approval (`budgets.tf`). Staging and production are separate budgets; the program total is roughly A + B.

## Scenarios (USD per month, 730 hours, unverified prices)

### A. Lean development / staging (staging.tfvars.example)

| Component | USD / month |
|---|---:|
| Fargate tasks | 108 |
| NAT gateways (hourly + data) | 37 |
| Load balancers | 45 |
| RDS (instances + storage) | 59 |
| ElastiCache Redis | 23 |
| WAF | 9 |
| CloudFront (not implemented yet) | 0 |
| CloudWatch logs | 5 |
| Interface VPC endpoints | 0 |
| KMS + Secrets Manager | 4 |
| **Total** | **290** |

### B. MVP production (production.tfvars.example defaults + CloudFront)

| Component | USD / month |
|---|---:|
| Fargate tasks | 216 |
| NAT gateways (hourly + data) | 88 |
| Load balancers | 68 |
| RDS (instances + storage) | 268 |
| ElastiCache Redis | 47 |
| WAF | 20 |
| CloudFront (not implemented yet) | 43 |
| CloudWatch logs | 26 |
| Interface VPC endpoints | 0 |
| KMS + Secrets Manager | 4 |
| **Total** | **780** |

### C. Enterprise high availability (3 AZ, replica, interface endpoints)

| Component | USD / month |
|---|---:|
| Fargate tasks | 865 |
| NAT gateways (hourly + data) | 324 |
| Load balancers | 208 |
| RDS (instances + storage) | 1,924 |
| ElastiCache Redis | 460 |
| WAF | 133 |
| CloudFront (not implemented yet) | 427 |
| CloudWatch logs | 265 |
| Interface VPC endpoints | 88 |
| KMS + Secrets Manager | 5 |
| **Total** | **4,698** |

Scenario A mirrors `envs/staging.tfvars.example` (1 NAT, single-AZ database, one task per service). B mirrors the production defaults in `variables.tf` (2 NAT, Multi-AZ `db.m7g.large`, 2 tasks per service, 2-node Redis) plus the CloudFront that ADR 0055 requires. C is an illustrative upper bound, not a plan.

## What dominates, and what to do about it
| Driver | Observation (from the Terraform) | Recommendation | Security / availability effect |
|---|---|---|---|
| RDS | Largest line in B and C. Multi-AZ doubles instance and storage. Default class `db.m7g.large` is sized before any load data exists. | Right-size from staging load tests. Start production on the smallest class that passes the concurrency tests, Multi-AZ kept. Use Reserved Instances only after 2-3 months of steady usage. | None if Multi-AZ stays on. Do not run production single-AZ to save money. |
| Fargate | 5 services x `desired_count` 2 in production; portals at 0.5 vCPU / 1 GB. Staging runs 24x7. | Staging: scheduled scale to 0 outside working hours (tasks only; keep data). Production: leave minimum 2 for the API and the public website; evaluate 1 task for Admin and Supplier only if the owner accepts a short outage on a task failure. Compute Savings Plan after baseline. | Staging scaling to 0 is safe. Admin/Supplier at 1 task weakens availability: an owner decision, not made here. |
| NAT | One NAT in staging, one per AZ in production. Image pulls already avoid it through the S3 gateway endpoint. | Keep one NAT per AZ in production. Price interface endpoints for ECR (api, dkr), Logs and Secrets Manager against NAT data processing: they pay off only above a few hundred GB per month, and each endpoint costs per AZ per hour. Staging keeps the shared NAT. | Endpoints reduce internet egress paths (a small security gain). A single NAT in production is an AZ single point of failure: not recommended. |
| Two ALBs | A public ALB and an internal ALB for the API, each with a base hourly charge. | Keep both for now: the internal ALB is what keeps the API off the internet (ADR 0040). Merging them would require a public API listener, which is not a cost-only decision. | Merging weakens isolation. Not recommended. |
| Redis | `cache.t4g.small`, 2 nodes in production. Search cache only; it is not the ledger. | Keep staging at 1 node. Production 2 nodes is needed for failover; consider Valkey (cheaper) after a client compatibility test. | Single node in production loses cache on failure, not data. Acceptable only if the API degrades with a visible error, never with stale results (invariant 5). |
| WAF + CloudFront | WAF today only on the public ALB; CloudFront is not built. | Budget CloudFront egress (it often replaces some ALB data cost). Review WAF rule count: each managed group is billed monthly. | None. |
| CloudWatch | Container Insights is on; logs retained 30 (staging) and 90 days (production). | Keep. Do not add debug-level logging in production. A 1-year retention (checkov CKV_AWS_338) is a compliance decision with a cost: model it before approving. | Reducing retention would weaken auditability: not recommended. |
| Idle services | Workers are not deployed. The migrate task runs only on demand. | Keep it that way. Do not add always-on workers until a certified use case exists. | None. |
| Express Mode previews | Each is a throwaway service with its own ALB. | Delete on branch close; cap concurrent previews. | Previews must stay access-restricted. |

## Cost allocation
- Every resource gets `Project`, `Environment`, `Owner`, `CostCenter`, `Service`, `ManagedBy` from the provider `default_tags`; service-scoped resources (ECR, ECS service and task definition, log groups, target groups) override `Service` with the service name, and everything else is `Service=shared`. `Environment` splits the staging and production budgets.
- Before the budgets report anything, a Billing administrator must activate these six keys as **cost allocation tags** once per account (Billing > Cost allocation tags). Tags only report cost from the activation date.
- `propagate_tags = SERVICE` copies the service tags to running tasks. Untaggable items (data transfer, some support charges) appear under no tag; keep an unfiltered account-level budget as well (decision for the owner).
- Budget wiring: `monthly_budget_usd` > 0 and at least one `budget_emails` entry create the budget, with `budget_alert_thresholds` (default 80% actual, 100% actual, 100% forecast).

## Approval required (none of these is decided here)
1. Monthly ceiling per environment and the alert recipients.
2. Whether Admin and Supplier may run a single task in production.
3. Whether staging may be scheduled off-hours.
4. Reserved Instances / Savings Plans, only after a baseline exists.
5. Log retention policy and flow-log/WAF-log/ALB-log enablement (each adds cost).
