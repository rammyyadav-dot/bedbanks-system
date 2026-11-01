# AWS log classes and retention (WP3 3.7)

**Status: interim defaults, awaiting owner/compliance approval.** No regulatory retention requirement has been supplied to this work, so none is assumed. The numbers below are what the Terraform ships (`locals.tf`, overridable per environment with `log_retention`); each can be changed by a reviewed PR. Classes are intentionally different: they differ in sensitivity, volume and usefulness.

| Class | Sink | Staging | Production | Why this long | Sensitivity and controls | Cost lever |
|---|---|---|---|---|---|---|
| Application (ECS) | CloudWatch Logs, KMS | 30 d | 90 d | covers incident analysis and a quarterly review of errors | the apps must not log tokens, guest PII or raw supplier payloads (CLAUDE.md invariant 7); KMS-encrypted | log level; Container Insights is separate |
| RDS `postgresql`/`upgrade` | CloudWatch Logs, KMS | 30 d | 90 d | connection and DDL audit trail, slow statements (>1 s) | `log_statement = ddl` (never `all`: it would capture guest PII); RLS and role boundaries unchanged | `log_min_duration_statement` |
| VPC flow logs | CloudWatch Logs, KMS | 14 d | 90 d | network forensics; metadata only (addresses, ports, bytes), no payload | contain client IPs of business users: limit retention, restrict reads | 10-minute aggregation, ALL traffic; can be switched off only by an explicit `enable_flow_logs = false` |
| ALB access logs | private S3 (SSE-S3, TLS-only, versioned) | 30 d | 180 d | request forensics and abuse investigation | URLs and query strings can carry identifiers: keep short, private, no public access, no KMS (service limitation) | lifecycle expiry, noncurrent versions 7 d |
| WAF logs (regional, CloudFront) | CloudWatch Logs, KMS | 30 d | 90 d | evidence of blocked attacks and rule tuning | `Authorization` and `Cookie` redacted; only BLOCK/COUNT kept (allowed traffic is not logged) | the filter |
| CloudTrail | account level, outside this stack | per the security team | per the security team | audit | see `docs/aws-account-security-checklist.md` | n/a |

## What needs a decision
1. Is there a regulatory or contractual retention requirement (for example supplier contracts, tax, data-protection law in India/UAE/EU)? If one exists it overrides the table for the class it covers. Classes holding client IPs or URLs may also have a **maximum** (minimisation), not only a minimum.
2. Is one year (the generic scanner standard, `CKV_AWS_338`) wanted for any class? Cost grows linearly with retention; request an estimate with `tools/aws/cost-model.py` before approving.
3. Who may read each class, and is access to ALB/flow logs logged?

## Control of ingestion and storage cost
Flow-log aggregation at 10 minutes, WAF logs filtered to BLOCK/COUNT, S3 lifecycle on ALB logs, explicit retention on every log group (a group without retention is a CI failure: `check:aws-governance`), RDS log groups created by Terraform with retention before RDS can create unlimited ones. See `docs/aws-cost-model.md` for the estimated effect.
