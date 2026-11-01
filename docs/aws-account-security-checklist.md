# AWS account security checklist (WP2)

Audit, not assumption. Organizations, Identity Center, CloudTrail and the Terraform backend live **outside** this repository's stack, so their absence from Terraform says nothing about whether they exist. Status below is what the repository proves; every account-level status is **UNVERIFIED** until `infra/aws/audit/account-audit.sh` is run by a read-only identity and its output is attached to `docs/aws-verification-evidence.md`.

Rules: this work creates no organization-wide resource (SCPs, org trails, Identity Center, account vending) without explicit written authorization, and the audit script only reads.

How to run: `infra/aws/audit/account-audit.sh <region> <state-bucket> <lock-table> [cloudtrail-bucket]` with a ViewOnly/SecurityAudit role. `UNKNOWN` means the identity could not see the control, which is not a pass.

| # | Control | What "good" means | Repo evidence | Account status |
|---|---|---|---|---|
| 1 | AWS Organizations | Staging and production in separate member accounts under one organization; management account holds no workloads | Terraform is per environment and region-neutral; ADR 0040 recommends separate accounts | UNVERIFIED (`organizations`) |
| 2 | Service control policies | Deny region outside `ap-south-1` (+ `us-east-1` for CloudFront/WAF/ACM), deny leaving the organization, deny disabling CloudTrail/GuardDuty | None (org-wide: needs authorization) | UNVERIFIED, not created |
| 3 | IAM Identity Center | Humans sign in with SSO and MFA; permission sets are least privilege; no long-lived IAM users | Workflows use OIDC, no access keys (guard: `check:aws-governance`) | UNVERIFIED (`identity-center`, `iam-users`) |
| 4 | Privileged access | Separate permission sets for read-only, deploy-operator and break-glass admin; break-glass alarmed; production access time-boxed and approved | None | UNVERIFIED |
| 5 | Root account | MFA on, no access keys, not used day to day | None | UNVERIFIED (`root-mfa`, `root-access-keys`) |
| 6 | CloudTrail | Multi-region (or organization) trail, log file validation, KMS-encrypted, delivered to a separate log-archive account bucket with versioning, public block and deny-delete; Insights optional | Not in Terraform | UNVERIFIED (`cloudtrail:*`) |
| 7 | Terraform state bucket | Versioning on, SSE-KMS, all public access blocked, TLS-only policy, access limited to the apply role | Runbook step 1 says "versioned, encrypted, private" but nothing enforces it | UNVERIFIED (`tfstate-*`) |
| 8 | State locking | DynamoDB table with hash key `LockID` (Terraform 1.9.x; native S3 locking needs 1.10+) and point-in-time recovery | `backend "s3" {}` is partial; lock table is passed at `init` | UNVERIFIED (`tfstate-lock-table`) |
| 9 | State contents | State may contain resource attributes (RDS endpoint, ARNs). Secret values are never in state: Terraform creates empty Secrets Manager secrets and RDS manages the owner password | `secrets.tf`, `data.tf` (`manage_master_user_password`) | Repo: PASS by design; account: UNVERIFIED |
| 10 | GitHub OIDC provider | One provider for `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` | `iam.tf` | Repo: PASS; account: UNVERIFIED |
| 11 | OIDC trust: build role | `StringEquals` on `aud` and an exact `sub` = `repo:<owner/repo>:ref:refs/heads/main`; no wildcard | `iam.tf` `github_trust["build"]`; enforced by `check:aws-governance` and its mutation tests | Repo: PASS; deployed role: UNVERIFIED (`oidc-trust:*`) |
| 12 | OIDC trust: deploy role | Exact `sub` = `repo:<owner/repo>:environment:<env>`; the GitHub environment has required reviewers and (production) a branch restriction | `iam.tf`; the environment settings are GitHub-side and not verifiable from the repo | Repo: PASS; GitHub environment protection: UNVERIFIED |
| 13 | Build role permissions | ECR push to the five repositories only | `iam.tf` `github_build` | PASS (static) |
| 14 | Deploy role permissions | Update only the five services; register task definitions; read image digests; pass only task roles to ECS | `iam.tf` `github_deploy` | PASS (static). Changed in WP2: removed `ecs:RunTask` and `PassRole` of the migrate role (a CI role must not be able to start the owner-credential migration); added `ecr:DescribeImages`; `PassRole` constrained to `ecs-tasks.amazonaws.com` |
| 15 | Known residual in deploy role | `ecs:RegisterTaskDefinition` and `Describe*` cannot be resource-scoped, and a principal that can register a task definition and update a service can run arbitrary code with the task roles | `iam.tf` | OPEN, accepted: bounded by environment reviewers and by task roles holding no AWS permissions |
| 16 | Secrets | Runtime URLs set out of band; only the migrate execution role reads the owner secret; KMS key rotation on | `iam.tf`, `secrets.tf`, `data.tf` | PASS (static); rotation of runtime URLs OPEN (CKV2_AWS_57) |
| 17 | Data security | RDS and Redis in no-internet data subnets, encrypted, TLS | `network.tf`, `data.tf` | PASS (static); Redis AUTH/RBAC OPEN |
| 18 | Detective controls | GuardDuty, Security Hub, AWS Config, VPC flow logs, WAF and ALB access logs | None in this stack | OPEN: not enabled by this work (cost and org decisions) |
| 19 | Budgets and cost anomaly | Per-environment budgets with tags activated; anomaly detection | `budgets.tf` (off until a ceiling is approved) | PARTIAL |
| 20 | Break-glass and recovery | Documented emergency access, tested RDS restore and rollback | Runbook describes; nothing has been exercised | BLOCKER: needs staging infrastructure |

## Decisions needed from the owner
1. Is there an AWS Organization? Which accounts will hold staging, production, log archive?
2. Is Identity Center in use, and in which home region?
3. Where is the CloudTrail trail delivered, and who can delete from that bucket?
4. Names of the state bucket and lock table (and whether they were created with versioning/KMS).
5. Authorization to create any organization-wide control (items 2, 6, 18).
