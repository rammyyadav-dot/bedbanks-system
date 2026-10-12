# Checkov exception register (WP3)

Source of truth for `infra/aws/terraform/.checkov.yaml`. `pnpm check:aws-governance` fails when a skipped check is not listed here or has no reason in the YAML. Checkov 3.2.0, 319 checks pass and 0 fail on commit `<see docs/aws-wp3-verification-evidence.md>`.

**Status meaning.** `PROPOSED` = written by the engineer, **not yet approved** by the owner; nothing in this register is an approved risk acceptance until the Owner column is signed and the date filled in. `OPEN` is never an acceptance: it is a tracked gap. Review-by dates are proposals.

Owner (proposed for all rows): **fBeds platform lead; approval by the CTO**. Approval: _unsigned_.

## Remediated in WP3 (no longer skipped; the check now runs and passes)
| Check | Finding | Remediation |
|---|---|---|
| CKV_AWS_31 | Redis AUTH | `auth_token` from `random_password` in Secrets Manager `REDIS_URL` (`data.tf`, `secrets.tf`) |
| CKV2_AWS_11 | VPC flow logs | `aws_flow_log` to a KMS log group (`logging.tf`) |
| CKV2_AWS_31 | WAF logging | regional and CloudFront ACL logging, redacted, BLOCK/COUNT only |
| CKV_AWS_91 | ALB access logs | private TLS-only S3 bucket, both ALBs |
| CKV_AWS_118 | RDS enhanced monitoring | `monitoring_interval = 60` with a scoped role |
| CKV_AWS_129 | RDS log exports | `postgresql`, `upgrade` exported, explicit retention |
| CKV2_AWS_64 | KMS key policy | explicit policy (also required for CloudWatch Logs and alarms) |
| CKV2_AWS_32 | CloudFront response headers policy | baseline policy with `override = false` |
| CKV2_AWS_12 | default security group (WP2) | `aws_default_security_group` with no rules |

## ACCEPTED (PROPOSED)
| Check | Finding | Resource | Reason | Review by | Status |
|---|---|---|---|---|---|
| CKV2_AWS_5 | SG not attached | `aws_security_group.this[*]` | attached through `for_each` resources the tool cannot follow | 2027-10-11 | PROPOSED |
| CKV2_AWS_19 | EIP not attached | NAT EIP | attached to the NAT gateway | 2027-10-11 | PROPOSED |
| CKV2_AWS_38 | DNSSEC | private zone | not applicable to a VPC-only zone | 2027-10-11 | PROPOSED |
| CKV2_AWS_39 | Route 53 query logging | private zone | not available here; Resolver query logs are a separate decision | 2027-04-11 | PROPOSED |
| CKV2_AWS_50 | Redis Multi-AZ | staging | production is Multi-AZ; staging single node by cost design | 2027-10-11 | PROPOSED |
| CKV_AWS_150 | ALB deletion protection | staging | on in production; off in staging so it can be destroyed | 2027-10-11 | PROPOSED |
| CKV_AWS_293 | RDS deletion protection | staging | on in production; off in staging | 2027-10-11 | PROPOSED |
| CKV_AWS_161 | RDS IAM auth | RDS | strict runtime role model uses Secrets Manager credentials (ADR 0040/0008); changing the auth boundary needs its own decision | 2027-04-11 | PROPOSED |
| CKV_AWS_356 | `*` resource in IAM | `github_deploy` | `ecs:Describe*`, `ListTasks`, `ecr:GetAuthorizationToken` support no resource-level permission | 2027-10-11 | PROPOSED |
| CKV_AWS_109 / CKV_AWS_111 | key-policy wildcard | `kms_data`, `kms_edge_logs` | the standard root statement delegating one key to IAM; the governance check allows exactly this statement and no other wildcard allow | 2027-10-11 | PROPOSED |
| CKV_AWS_145 | S3 not KMS-encrypted | ALB log bucket | ALB log delivery supports only SSE-S3; SSE-KMS breaks delivery | 2027-10-11 | PROPOSED |
| CKV_AWS_18 | S3 access logging | ALB log bucket | the bucket is the log sink | 2027-10-11 | PROPOSED |
| CKV_AWS_144 | cross-region replication | ALB log bucket | short-retention operational logs; single region by ADR 0055 | 2027-10-11 | PROPOSED |
| CKV2_AWS_62 | S3 event notifications | ALB log bucket | no consumer | 2027-10-11 | PROPOSED |
| CKV2_AWS_47 | Log4j managed rule on CloudFront ACL | edge ACL | the rule set is present without overrides; the tool cannot follow the count-indexed ACL; asserted statically | 2027-04-11 | PROPOSED |
| CKV_AWS_305 | default root object | distributions | applies to S3 origins; the origin serves `/` | 2027-10-11 | PROPOSED |
| CKV_AWS_310 | origin failover | distributions | single multi-AZ ALB origin | 2027-04-11 | PROPOSED |

## OPEN (not remediated)
| Check | Gap | Why not done | Next action | Review by |
|---|---|---|---|---|
| CKV2_AWS_57 | No automatic rotation of the runtime DB and Redis URL secrets | rotating `fbeds_api_login` needs a purpose-built rotation function that coordinates the role password, the URL secret and a forced redeploy, and must not widen grants | follow `docs/aws-secret-rotation-runbook.md` (manual, drilled); decide on a custom rotation Lambda after the first staging rotation drill | 2027-01-11 |
| CKV_AWS_338 | CloudWatch retention below one year (14-180 days by class) | no regulatory retention requirement has been supplied; a year of all log classes is a recurring cost | owner states the requirement per class (`docs/aws-log-retention-policy.md`); set `log_retention` | 2027-01-11 |
| CKV_AWS_86 | CloudFront standard (v2) access logs | design choice (CloudWatch or S3 delivery in us-east-1) and cost; ALB access logs and edge WAF logs cover the same traffic | decide the destination, then add `aws_cloudwatch_log_delivery*` in us-east-1 | 2027-01-11 |
