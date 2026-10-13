#!/usr/bin/env bash
# READ-ONLY audit of the AWS account foundations that live outside Terraform (docs/aws-account-security-checklist.md).
# Uses only describe/list/get calls. It creates, changes and deletes nothing. Run it with a read-only (ViewOnly/SecurityAudit) identity:
#   infra/aws/audit/account-audit.sh <region> <terraform-state-bucket> <lock-table> [cloudtrail-bucket]
# Output: one line per control, PASS | FAIL | UNKNOWN (UNKNOWN = the identity cannot see it; that is not a pass).
set -uo pipefail
REGION="${1:?region}"; STATE_BUCKET="${2:?state bucket}"; LOCK_TABLE="${3:?lock table}"; TRAIL_BUCKET="${4:-}"
aws() { command aws --region "$REGION" --output json "$@"; }
say() { printf '%-8s %-34s %s\n' "$1" "$2" "$3"; }
j() { jq -r "$1" 2>/dev/null; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "no AWS credentials" >&2; exit 2; }

# Organizations
if out=$(aws organizations describe-organization 2>&1); then say PASS organizations "member of $(j .Organization.Id <<<"$out"), feature set $(j .Organization.FeatureSet <<<"$out")"
elif grep -q AWSOrganizationsNotInUse <<<"$out"; then say FAIL organizations "account is standalone (no AWS Organization)"
else say UNKNOWN organizations "cannot read: $(head -c 120 <<<"$out")"; fi

# IAM Identity Center (instances are listed in its home region; try the given one)
if out=$(aws sso-admin list-instances 2>&1); then
  n=$(j '.Instances|length' <<<"$out")
  if [ "${n:-0}" -ge 1 ]; then say PASS identity-center "$n instance(s) in $REGION"; else say FAIL identity-center "no instance in $REGION (may live in another region)"; fi
else say UNKNOWN identity-center "cannot read: $(head -c 120 <<<"$out")"; fi

# Root account and IAM users
if out=$(aws iam get-account-summary 2>&1); then
  if [ "$(j .SummaryMap.AccountMFAEnabled <<<"$out")" = 1 ]; then say PASS root-mfa "root MFA enabled"; else say FAIL root-mfa "root MFA not enabled"; fi
  if [ "$(j .SummaryMap.AccountAccessKeysPresent <<<"$out")" = 0 ]; then say PASS root-access-keys "no root access keys"; else say FAIL root-access-keys "root access keys exist"; fi
  say INFO iam-users "$(j .SummaryMap.Users <<<"$out") IAM user(s); humans should use Identity Center, not IAM users"
else say UNKNOWN root-mfa "cannot read: $(head -c 120 <<<"$out")"; fi

# CloudTrail
if out=$(aws cloudtrail describe-trails --include-shadow-trails 2>&1); then
  n=$(j '.trailList|length' <<<"$out"); [ "${n:-0}" -ge 1 ] || say FAIL cloudtrail "no trail"
  while IFS=$'\t' read -r name multi validate kms org bucket; do
    log=$(aws cloudtrail get-trail-status --name "$name" 2>/dev/null | j .IsLogging)
    [ "$log" = true ] && [ "$multi" = true ] && [ "$validate" = true ] && [ "$kms" != null ] && s=PASS || s=FAIL
    say "$s" "cloudtrail:$name" "logging=$log multiRegion=$multi logValidation=$validate kms=$([ "$kms" = null ] && echo no || echo yes) orgTrail=$org bucket=$bucket"
    [ -z "$TRAIL_BUCKET" ] && TRAIL_BUCKET="$bucket"
  done < <(j '.trailList[]|[.Name,.IsMultiRegionTrail,.LogFileValidationEnabled,.KmsKeyId,.IsOrganizationTrail,.S3BucketName]|@tsv' <<<"$out")
else say UNKNOWN cloudtrail "cannot read: $(head -c 120 <<<"$out")"; fi

# Bucket protections (Terraform state and CloudTrail log bucket)
bucket_checks() {
  local b="$1" tag="$2" v e p
  v=$(aws s3api get-bucket-versioning --bucket "$b" 2>/dev/null | j '.Status // "none"')
  if [ "$v" = Enabled ]; then say PASS "$tag-versioning" "$b"; else say FAIL "$tag-versioning" "$b status=${v:-unreadable}"; fi
  e=$(aws s3api get-bucket-encryption --bucket "$b" 2>/dev/null | j '.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm')
  if [ -n "$e" ] && [ "$e" != null ]; then say PASS "$tag-encryption" "$b $e"; else say FAIL "$tag-encryption" "$b not encrypted/unreadable"; fi
  p=$(aws s3api get-public-access-block --bucket "$b" 2>/dev/null | j '[.PublicAccessBlockConfiguration[]]|all')
  if [ "$p" = true ]; then say PASS "$tag-public-block" "$b"; else say FAIL "$tag-public-block" "$b public access not fully blocked"; fi
}
bucket_checks "$STATE_BUCKET" tfstate
[ -n "$TRAIL_BUCKET" ] && bucket_checks "$TRAIL_BUCKET" cloudtrail-bucket
# State locking (Terraform 1.9.x uses DynamoDB)
if out=$(aws dynamodb describe-table --table-name "$LOCK_TABLE" 2>&1); then
  k=$(j '.Table.KeySchema[0].AttributeName' <<<"$out")
  if [ "$k" = LockID ]; then say PASS tfstate-lock-table "$LOCK_TABLE hash key LockID"; else say FAIL tfstate-lock-table "hash key is $k, Terraform needs LockID"; fi
else say FAIL tfstate-lock-table "cannot describe $LOCK_TABLE: $(head -c 100 <<<"$out")"; fi

# GitHub OIDC provider and role trust
if out=$(aws iam list-open-id-connect-providers 2>&1); then
  arn=$(j '.OpenIDConnectProviderList[].Arn|select(contains("token.actions.githubusercontent.com"))' <<<"$out")
  if [ -n "$arn" ]; then say PASS github-oidc-provider "$arn"; else say INFO github-oidc-provider "absent (Terraform phase 1 creates it)"; fi
else say UNKNOWN github-oidc-provider "cannot read"; fi
for role in $(aws iam list-roles 2>/dev/null | j '.Roles[]|select(.RoleName|test("^fbeds-.*-github-(build|deploy)$"))|.RoleName'); do
  doc=$(aws iam get-role --role-name "$role" | j '.Role.AssumeRolePolicyDocument|tojson')
  if grep -q StringLike <<<"$doc" || grep -Eq 'repo:[^"]*\*' <<<"$doc" || ! grep -q 'token.actions.githubusercontent.com:aud' <<<"$doc"; then say FAIL "oidc-trust:$role" "wildcard sub, StringLike, or no aud pin"; else say PASS "oidc-trust:$role" "$(j '.Statement[0].Condition.StringEquals|to_entries[]|"\(.key)=\(.value)"' <<<"$doc" | tr '\n' ' ')"; fi
done

# Budgets
acct=$(aws sts get-caller-identity | j .Account)
if out=$(aws budgets describe-budgets --account-id "$acct" 2>&1); then say INFO budgets "$(j '.Budgets|length' <<<"$out") budget(s): $(j '[.Budgets[].BudgetName]|join(", ")' <<<"$out")"; else say UNKNOWN budgets "cannot read"; fi
