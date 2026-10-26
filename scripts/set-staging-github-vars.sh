#!/usr/bin/env bash
# Owner-run: sets the GitHub `staging` environment variables the AWS workflows read (docs/runbooks/aws-ecs-deployment.md step 2, ADR 0090).
# Nothing here is a secret. Run it from your own shell with `gh` logged in as a repository admin, AFTER terraform phase 1 produced the role ARNs.
#
#   AWS_REGION=ap-south-1 AWS_BUILD_ROLE_ARN=arn:aws:iam::<acct>:role/fbeds-staging-github-build AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<acct>:role/fbeds-staging-github-deploy \
#   NEXT_PUBLIC_SITE_URL=https://staging.<domain> NEXT_PUBLIC_AGENT_URL=https://agent.staging.<domain> NEXT_PUBLIC_ADMIN_URL=https://admin.staging.<domain> \
#   NEXT_PUBLIC_SUPPLIER_URL=https://supplier.staging.<domain> NEXT_PUBLIC_CONTACT_EMAIL=<address> \
#   scripts/set-staging-github-vars.sh [--smoke-url https://admin.staging.<domain>/api/v1/health/ready] [--enable] [--dry-run]
#
# --enable sets the repository variable STAGING_PIPELINE_ENABLED=true. Do that last, after one manual "AWS deploy" to staging succeeded.
set -Eeuo pipefail

SMOKE=""; ENABLE=false; DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --smoke-url) SMOKE="${2:?--smoke-url needs a value}"; shift 2 ;;
    --enable) ENABLE=true; shift ;;
    --dry-run) DRY=true; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
command -v gh >/dev/null || { echo "gh is required" >&2; exit 2; }

role='^arn:aws:iam::[0-9]{12}:role/fbeds-staging-github-(build|deploy)$'
[ "${AWS_REGION:-}" = ap-south-1 ] || { echo "AWS_REGION must be ap-south-1 (ADR 0055)" >&2; exit 2; }
[[ "${AWS_BUILD_ROLE_ARN:-}" =~ $role && "$AWS_BUILD_ROLE_ARN" == *-build ]] || { echo "AWS_BUILD_ROLE_ARN must be the fbeds-staging-github-build role ARN" >&2; exit 2; }
[[ "${AWS_DEPLOY_ROLE_ARN:-}" =~ $role && "$AWS_DEPLOY_ROLE_ARN" == *-deploy ]] || { echo "AWS_DEPLOY_ROLE_ARN must be the fbeds-staging-github-deploy role ARN" >&2; exit 2; }
for v in NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_AGENT_URL NEXT_PUBLIC_ADMIN_URL NEXT_PUBLIC_SUPPLIER_URL; do
  [[ "${!v:-}" == https://* ]] || { echo "$v must be an https URL" >&2; exit 2; }
done
[ -n "${NEXT_PUBLIC_CONTACT_EMAIL:-}" ] || { echo "NEXT_PUBLIC_CONTACT_EMAIL is required" >&2; exit 2; }
[ -z "$SMOKE" ] || [[ "$SMOKE" == https://* ]] || { echo "--smoke-url must be https" >&2; exit 2; }

set_var() { # name value [env]
  if [ "$DRY" = true ]; then echo "dry run: would set ${3:+$3 environment }variable $1"; return; fi
  if [ -n "${3:-}" ]; then gh variable set "$1" --env "$3" --body "$2"; else gh variable set "$1" --body "$2"; fi
  echo "set $1"
}
if [ "$DRY" != true ]; then gh api "repos/{owner}/{repo}/environments/staging" --silent 2>/dev/null || gh api -X PUT "repos/{owner}/{repo}/environments/staging" --silent; fi
for v in AWS_REGION AWS_BUILD_ROLE_ARN AWS_DEPLOY_ROLE_ARN NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_AGENT_URL NEXT_PUBLIC_ADMIN_URL NEXT_PUBLIC_SUPPLIER_URL NEXT_PUBLIC_CONTACT_EMAIL; do
  set_var "$v" "${!v}" staging
done
[ -z "$SMOKE" ] || set_var STAGING_SMOKE_URL "$SMOKE"
if [ "$ENABLE" = true ]; then set_var STAGING_PIPELINE_ENABLED true; else echo "STAGING_PIPELINE_ENABLED left unset (pipeline inert). Re-run with --enable after a manual deploy succeeds."; fi
echo "Still manual: add required reviewers to the staging environment and restrict it to the main branch (Settings > Environments)."
