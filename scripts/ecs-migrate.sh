#!/usr/bin/env bash
# Owner-run Prisma migration on AWS ECS for ONE commit (docs/runbooks/aws-ecs-deployment.md step 4, ADR 0040/0055/0075).
#
#   scripts/ecs-migrate.sh <staging|production> <40-char commit SHA> [--dry-run]
#
# Why this exists: the Terraform migrate task definition is pinned to var.initial_image_tag (lifecycle ignore_changes), and `run-task` cannot override a
# container image. Running that family as-is re-applies the FIRST release's migrations and silently skips every later one. This registers a new revision
# pinned to the digest of fbeds/api:<sha>-migrate, runs it once, and fails unless the container exits 0.
#
# Runs with YOUR (owner) AWS credentials. The CI deploy role intentionally has no ecs:RunTask and no iam:PassRole for the migrate role, so this can never
# be reached from GitHub Actions. Take an RDS snapshot first; migrations are forward-only (docs/runbooks/rollback.md). Needs: aws, jq.
# Subnets and the security group come from the cluster's api service, so nothing is typed by hand.
set -Eeuo pipefail

ENVIRONMENT="${1:-}"; SHA="${2:-}"; DRY_RUN=false
[ "${3:-}" = "--dry-run" ] && DRY_RUN=true
[ -z "${3:-}" ] || [ "$DRY_RUN" = true ] || { echo "unknown option: $3" >&2; exit 2; }
case "$ENVIRONMENT" in staging|production) ;; *) echo "usage: $0 <staging|production> <40-char sha> [--dry-run]" >&2; exit 2 ;; esac
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "sha must be a full 40-character commit SHA" >&2; exit 2; }
for tool in aws jq; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done

CLUSTER="fbeds-$ENVIRONMENT"; FAMILY="$CLUSTER-migrate"; REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
[ -n "$REGION" ] || { echo "set AWS_REGION" >&2; exit 2; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Account $ACCOUNT, cluster $CLUSTER, region $REGION, commit $SHA"

digest="$(aws ecr describe-images --repository-name fbeds/api --image-ids imageTag="$SHA-migrate" --query 'imageDetails[0].imageDigest' --output text)" \
  || { echo "no fbeds/api:$SHA-migrate in ECR: run the AWS images workflow for this commit first" >&2; exit 1; }
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "unexpected digest '$digest'" >&2; exit 1; }
image="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fbeds/api@$digest"

aws ecs describe-task-definition --task-definition "$FAMILY" --query taskDefinition > "${TMPDIR:-/tmp}/migrate-td.$$.json"
trap 'rm -f "${TMPDIR:-/tmp}/migrate-td.$$.json" "${TMPDIR:-/tmp}/migrate-td-new.$$.json"' EXIT
jq --arg img "$image" 'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy) | (.containerDefinitions[] | select(.name=="migrate") | .image) = $img' \
  "${TMPDIR:-/tmp}/migrate-td.$$.json" > "${TMPDIR:-/tmp}/migrate-td-new.$$.json"
[ "$(jq -r '[.containerDefinitions[] | select(.name=="migrate")] | length' "${TMPDIR:-/tmp}/migrate-td-new.$$.json")" = 1 ] || { echo "$FAMILY has no 'migrate' container" >&2; exit 1; }

svc="$(aws ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
subnets="$(jq -r '.subnets | join(",")' <<<"$svc")"; sgs="$(jq -r '.securityGroups | join(",")' <<<"$svc")"
{ [ -n "$subnets" ] && [ -n "$sgs" ]; } || { echo "could not read the api service network configuration" >&2; exit 1; }
net="awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sgs],assignPublicIp=DISABLED}"

if [ "$DRY_RUN" = true ]; then echo "dry run: would register $FAMILY pinned to $image and run it in [$subnets]"; exit 0; fi
if [ "$ENVIRONMENT" = production ]; then
  read -r -p "Production migration of $SHA. RDS snapshot taken and staging certified on this commit? Type 'migrate production': " ans
  [ "$ans" = "migrate production" ] || { echo "aborted" >&2; exit 1; }
fi

arn="$(aws ecs register-task-definition --cli-input-json "file://${TMPDIR:-/tmp}/migrate-td-new.$$.json" --query taskDefinition.taskDefinitionArn --output text)"
echo "registered $arn"
task="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$arn" --network-configuration "$net" --count 1 --query 'tasks[0].taskArn' --output text)"
[[ "$task" == arn:aws:ecs:* ]] || { echo "run-task did not start a task" >&2; exit 1; }
echo "started ${task##*/}; waiting for it to stop"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
read -r code reason < <(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].[exitCode,reason]' --output text)
echo "log group /fbeds/$ENVIRONMENT/migrate, stream migrate/migrate/${task##*/}"
[ "$code" = 0 ] || { echo "migration FAILED (exit ${code:-none}, ${reason:-no reason}). Do not deploy this commit." >&2; exit 1; }
echo "migration succeeded for $SHA. Safe to run AWS deploy for this commit."
