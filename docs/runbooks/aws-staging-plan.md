# Staging: account audit and first `terraform plan` (read-only)

Purpose: get from "repository is ready" to "a human has read a real plan for staging", **without applying anything**. Everything here is read-only except section 3, which creates the Terraform state backend and is marked as such. Run it yourself with your own credentials; nothing in this repository can see your AWS account, and the plan script refuses to apply by construction (tested, and guarded in CI by `pnpm check:aws-governance`).

Needed from you before starting (none is invented by the repository): the **staging account id**, a role/profile with read access plus state access, the **Route 53 hosted zone id** for the staging names, the **staging IP ranges** (office/VPN egress), optionally the owner-approved budget and alert addresses.

## 0. Tools and credentials
`terraform` 1.9.x, `aws` CLI v2, `node` 20+, `jq`, `git`. Sign in to the **staging** account (for example `aws sso login --profile fbeds-staging`; `export AWS_PROFILE=fbeds-staging AWS_REGION=ap-south-1`). For the plan use a read-only role plus read/write on the state bucket and lock table, not an administrator; a plan only reads. Confirm where you are:
```bash
aws sts get-caller-identity
```

## 1. Account foundations audit (read-only)
```bash
infra/aws/audit/account-audit.sh ap-south-1 <state-bucket> <lock-table> [<cloudtrail-bucket>] | tee audit-staging.txt
```
Read every line: `PASS` is fine; `FAIL` and `UNKNOWN` are findings (UNKNOWN means your role could not see it, which is **not** a pass). The state-bucket lines will FAIL until section 3 is done; that is expected the first time. Attach the output to `docs/aws-wp3-verification-evidence.md` §6 via a pull request. Do not paste account ids or role ARNs into public places.

## 2. Find the values you need
```bash
aws route53 list-hosted-zones-by-name --dns-name fbeds.com --query 'HostedZones[].[Name,Id]' --output text   # hosted_zone_id (the part after /hostedzone/)
curl -s https://checkip.amazonaws.com                                                                     # your own egress address, if it is the office/VPN one
aws service-quotas get-service-quota --service-code vpc --quota-code L-0EA8095F --region ap-south-1        # rules per security group (L-0EA8095F is "Inbound or outbound rules per security group"; I could not verify the code offline, so check the Service Quotas console if the CLI rejects it). The CloudFront prefix list needs ~55 when the edge is enabled
aws rds describe-db-engine-versions --engine postgres --engine-version 16 --region ap-south-1 --query 'DBEngineVersions[].EngineVersion'
```
Check that the RDS 16 minor offered supports `vector` and `pg_trgm` (the migrations create both) and that the chosen instance class is offered in the region.

## 3. State backend: this is the ONLY step that creates AWS resources (a few cents a month; get the owner's go-ahead first)
Skip it if the audit shows the bucket and table already exist and pass. Otherwise, in the staging account:
```bash
export AWS_REGION=ap-south-1; ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="fbeds-staging-tfstate-$ACCT"; TABLE="fbeds-staging-tflock"
aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" --create-bucket-configuration LocationConstraint="$AWS_REGION" --object-ownership BucketOwnerEnforced
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
aws dynamodb create-table --table-name "$TABLE" --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --sse-specification Enabled=true --region "$AWS_REGION"
aws dynamodb update-continuous-backups --table-name "$TABLE" --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true --region "$AWS_REGION"
```
That uses the AWS-managed S3 key; a customer-managed key is stronger (and lets you restrict who can read state). The state holds the Redis AUTH token and the CloudFront origin-verify secrets (`docs/aws-secret-rotation-runbook.md`), so restrict bucket access to the people and roles that apply Terraform. Re-run section 1 and expect the four `tfstate-*` lines to PASS.

## 4. Your variable file (untracked)
```bash
cp infra/aws/terraform/envs/staging.tfvars.example infra/aws/terraform/envs/staging.tfvars   # git-ignored; never commit it
$EDITOR infra/aws/terraform/envs/staging.tfvars
```
Set at least: `hosted_zone_id` (section 2), `domain_name`, `public_ingress_cidrs` (your **real** trusted ranges; the example `203.0.113.0/24` and `0.0.0.0/0` are refused), `alarm_email`. Leave `create_portal_records` out (false). Leave `cloudfront_enabled` out for the first staging plan (ADR 0055 defers CloudFront for staging); try it in a second plan later. `monthly_budget_usd`/`budget_emails` are the **owner's** numbers: leave them unset to create no budget. The plan script refuses a file that still has placeholders, a non-staging environment, another region, or a world-open range.

## 5. Run the plan (read-only)
```bash
export EXPECT_ACCOUNT_ID=<12-digit staging account id>
export TF_STATE_BUCKET=<bucket from section 3>  TF_LOCK_TABLE=<table from section 3>
export TFVARS=infra/aws/terraform/envs/staging.tfvars
infra/aws/plan-staging.sh
```
It stops if your credentials are for a different account; runs `init` (encrypted S3 backend), `fmt -check`, `validate` and the offline `terraform test`; makes the plan; and runs `tools/aws-plan-review.mjs` over it. Outputs land in `./plan-out/` (`plan.txt`, `plan.json`, `plan.bin`): treat them as **sensitive** (owner-only, git-ignored, do not paste into tickets or chat). The exit code is 0 only when the mechanical review has no blocking finding.

## 6. Read the plan (a person; the script does not replace this)
Open `plan-out/plan.txt` and work through `docs/aws-staging-readiness-checklist.md` section C. In particular confirm, resource by resource: only creates (a first plan has no updates or deletes); the RDS and Redis are in the data subnets, encrypted, not public; the public ALB security group admits only your ranges; no `aws_route53_record` with a portal name (the ACM **validation** CNAMEs are expected: they write to your public zone when applied, which is a DNS change to approve); every resource shows the six tags; IAM roles and policies are the ones in `iam.tf` (no wildcard allows; the deploy role has no `ecs:RunTask`); the log groups, flow log, ALB log bucket and WAF logging are present; the cost drivers match `docs/aws-cost-model.md`. Every `REVIEW` line the script printed needs a decision from you.

## 7. Stop here
This sequence ends at a plan. **Do not apply until the owner has approved**: the account audit result, the region and sizing, the cost ceiling, the exact plan, and the change to the public zone (certificate validation records). When approved, apply in the order of `docs/runbooks/aws-ecs-deployment.md` step 2 (a targeted phase 1 for ECR/OIDC/roles, then images, then phase 2); that runbook, not this one, owns the apply. Re-plan immediately before applying, because the account may have changed since this plan was read.

## What this does not prove
That AWS accepts the configuration (quotas, instance availability, `vector` in the chosen minor), that logs and alarms deliver, that the edge cannot be bypassed, that image digests are equal, or that restore and rollback work. Those need the applied staging stack: `docs/aws-staging-readiness-checklist.md` section E.
