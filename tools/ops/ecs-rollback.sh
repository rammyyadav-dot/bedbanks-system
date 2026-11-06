#!/usr/bin/env bash
# Application rollback of one ECS service (docs/runbooks/rollback.md, ADR 0086).
# The AWS rollback workflow runs this script. It never calls RDS, SNS, or the database.
#
# Required environment: CLUSTER (fbeds-staging or fbeds-production), SERVICE (api|admin|agent|supplier|website),
# ACTOR, REASON. REVISION empty means the newest ACTIVE revision strictly below the one that is running.
set -euo pipefail

: "${CLUSTER:?CLUSTER is required}"
: "${SERVICE:?SERVICE is required}"
: "${ACTOR:?ACTOR is required}"
: "${REASON:?REASON is required}"
REVISION="${REVISION:-}"

[[ "$CLUSTER" == fbeds-staging || "$CLUSTER" == fbeds-production ]] || { echo "CLUSTER must be fbeds-staging or fbeds-production" >&2; exit 1; }
[[ "$SERVICE" =~ ^(api|admin|agent|supplier|website)$ ]] || { echo "SERVICE must be api, admin, agent, supplier or website" >&2; exit 1; }
[[ -z "$REVISION" || "$REVISION" =~ ^[0-9]+$ ]] || { echo "revision must be a number" >&2; exit 1; }

family="$CLUSTER-$SERVICE"
current=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
[[ "$current" == arn:aws:ecs:*:task-definition/"$family":* ]] || { echo "unexpected running task definition '$current'" >&2; exit 1; }
cur_rev=${current##*:}
if [ -z "$REVISION" ]; then
  # Newest ACTIVE revision strictly below the running one.
  REVISION=$(aws ecs list-task-definitions --family-prefix "$family" --status ACTIVE --sort DESC --query 'taskDefinitionArns' --output text | tr '\t' '\n' \
    | awk -F: -v cur="$cur_rev" -v fam="$family" '{ if ($NF + 0 < cur + 0 && $(NF-1) == "task-definition/" fam) { print $NF; exit } }')
  [ -n "$REVISION" ] || { echo "no earlier ACTIVE revision of $family below $cur_rev" >&2; exit 1; }
fi
[ "$REVISION" != "$cur_rev" ] || { echo "$family:$REVISION is already running" >&2; exit 1; }
target=$(aws ecs describe-task-definition --task-definition "$family:$REVISION" --query 'taskDefinition.[taskDefinitionArn,status,containerDefinitions[?name==`'"$SERVICE"'`].image|[0]]' --output text)
read -r arn status image <<<"$target"
[ "$status" = ACTIVE ] || { echo "$family:$REVISION is $status" >&2; exit 1; }
[[ "$image" == *@sha256:* ]] || { echo "$family:$REVISION is not pinned to a digest ($image); refusing" >&2; exit 1; }
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$arn" >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
now=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
[ "$now" = "$arn" ] || { echo "$SERVICE did not settle on $arn (now $now)" >&2; exit 1; }
read -r running desired deployments < <(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[runningCount,desiredCount,length(deployments)]' --output text)
{ [ "$running" = "$desired" ] && [ "$deployments" = 1 ]; } || { echo "$SERVICE not fully rolled: running=$running desired=$desired deployments=$deployments" >&2; exit 1; }
summary="${GITHUB_STEP_SUMMARY:-}"
{
  echo "### Rolled back $SERVICE in $CLUSTER"
  echo "- from revision $cur_rev to $REVISION ($image)"
  echo "- requested by $ACTOR"
  echo "- reason: $REASON"
} >> "${summary:-/dev/stdout}"
