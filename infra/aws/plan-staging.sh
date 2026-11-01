#!/usr/bin/env bash
# READ-ONLY staging plan: init, validate, offline tests, plan, mechanical review. It NEVER applies or destroys anything and writes no AWS resource.
# It only reads AWS (STS identity and the data sources/state the plan needs) and writes local files under $OUT_DIR.
#
# Required environment (nothing is defaulted that could point at the wrong account):
#   EXPECT_ACCOUNT_ID  12-digit id of the STAGING account; the script stops if your credentials belong to another account
#   TF_STATE_BUCKET    existing S3 state bucket (versioned, encrypted, private; see docs/runbooks/aws-staging-plan.md)
#   TF_LOCK_TABLE      existing DynamoDB lock table (hash key LockID)
#   TFVARS             path to YOUR filled-in, untracked staging variable file (copy of envs/staging.tfvars.example)
# Optional: AWS_REGION (default ap-south-1), TF_STATE_KEY (default fbeds/staging.tfstate), OUT_DIR (default ./plan-out)
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
STATE_KEY="${TF_STATE_KEY:-fbeds/staging.tfstate}"
OUT_DIR="${OUT_DIR:-./plan-out}"
ROOT="$(git rev-parse --show-toplevel)"
TF_DIR="$ROOT/infra/aws/terraform"

die() { echo "STOP: $*" >&2; exit 2; }
need() { command -v "$1" >/dev/null || die "$1 is required but not installed"; }

for v in EXPECT_ACCOUNT_ID TF_STATE_BUCKET TF_LOCK_TABLE TFVARS; do [ -n "${!v:-}" ] || die "$v is not set (see the header of this script)"; done
[[ "$EXPECT_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "EXPECT_ACCOUNT_ID must be a 12-digit account id"
[ "$REGION" = "ap-south-1" ] || die "region is $REGION; ADR 0055 approves ap-south-1 only (change the ADR first)"
need terraform; need aws; need node; need jq

# --- the variable file must be a real, filled-in STAGING file, never the example and never production ---
[ -f "$TFVARS" ] || die "TFVARS file not found: $TFVARS"
case "$(basename "$TFVARS")" in *.example) die "TFVARS is a template (*.example); copy it and fill it in" ;; esac
grep -Eq '^[[:space:]]*environment[[:space:]]*=[[:space:]]*"staging"' "$TFVARS" || die "TFVARS must set environment = \"staging\""
grep -Eq '^[[:space:]]*region[[:space:]]*=[[:space:]]*"ap-south-1"' "$TFVARS" || die "TFVARS must set region = \"ap-south-1\""
if grep -Eq 'ZXXXX|203\.0\.113\.|<[A-Za-z_ -]+>|example\.(com|test)' "$TFVARS"; then die "TFVARS still contains placeholder values (hosted zone id, documentation CIDR, <...> or example domains)"; fi
grep -Eq '^[[:space:]]*public_ingress_cidrs[[:space:]]*=' "$TFVARS" || die "TFVARS must set public_ingress_cidrs to the trusted staging ranges"
if grep -Eq '^[[:space:]]*public_ingress_cidrs[[:space:]]*=.*0\.0\.0\.0/0' "$TFVARS"; then die "public_ingress_cidrs must not contain 0.0.0.0/0 for staging"; fi
if grep -Eq '^[[:space:]]*create_portal_records[[:space:]]*=[[:space:]]*true' "$TFVARS"; then die "create_portal_records = true creates public DNS records; that is a cutover step, not part of a first plan"; fi

# --- you must be in the account you think you are in ---
ident="$(aws sts get-caller-identity --output json)" || die "no usable AWS credentials"
account="$(jq -r .Account <<<"$ident")"
[ "$account" = "$EXPECT_ACCOUNT_ID" ] || die "credentials belong to account $account, expected $EXPECT_ACCOUNT_ID"
echo "AWS identity: $(jq -r .Arn <<<"$ident") (account $account), region $REGION"

# --- the plan holds resource attributes and may hold sensitive values: private directory, owner-only files ---
umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
tf() { terraform -chdir="$TF_DIR" "$@"; }

tf init -input=false -reconfigure \
  -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="key=$STATE_KEY" -backend-config="region=$REGION" \
  -backend-config="dynamodb_table=$TF_LOCK_TABLE" -backend-config="encrypt=true"
tf fmt -check -recursive
tf validate
tf test

plan_rc=0
tf plan -input=false -lock-timeout=60s -detailed-exitcode -var-file="$(cd "$(dirname "$TFVARS")" && pwd)/$(basename "$TFVARS")" -out="$(cd "$OUT_DIR" && pwd)/plan.bin" || plan_rc=$?
[ "$plan_rc" -eq 0 ] || [ "$plan_rc" -eq 2 ] || die "terraform plan failed (exit $plan_rc)"
[ "$plan_rc" -eq 0 ] && echo "Plan: no changes."

tf show -json "$(cd "$OUT_DIR" && pwd)/plan.bin" > "$OUT_DIR/plan.json"
tf show -no-color "$(cd "$OUT_DIR" && pwd)/plan.bin" > "$OUT_DIR/plan.txt"

echo
echo "=== mechanical review (does not replace reading plan.txt) ==="
review_rc=0
node "$ROOT/tools/aws-plan-review.mjs" "$OUT_DIR/plan.json" --expect-region "$REGION" || review_rc=$?

echo
echo "Files (sensitive, owner-only, git-ignored; do not paste into tickets or chat): $OUT_DIR/plan.txt  plan.json  plan.bin"
echo "This script never applies. Applying needs the owner's explicit approval (docs/runbooks/aws-staging-plan.md, section 7)."
exit "$review_rc"
