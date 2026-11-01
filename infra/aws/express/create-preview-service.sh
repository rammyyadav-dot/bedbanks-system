#!/usr/bin/env bash
# Amazon ECS Express Mode: one command stands up a service with its own HTTPS load balancer, security groups, target group and auto scaling.
# Intended for STAGING and PREVIEW portals only (see ADR 0040). Production uses the Terraform-managed services, because it needs a private API
# load balancer, WAF, custom domains and explicit secrets, which Express Mode does not give us a handle on.
#
# Usage:  create-preview-service.sh <image-uri> <container-port> [extra aws args...]
# Roles come from the Terraform stack:  EXECUTION_ROLE_ARN (fbeds-<env>-ecs-execution)  INFRA_ROLE_ARN (an ECS infrastructure role for Express services)
# VERIFY BEFORE USE: only the three parameters AWS documents as required are passed here. Run `aws ecs create-express-gateway-service help` for the
# current options (health check path, CPU/memory, scaling, environment, secrets, network configuration) and append them as extra args.
set -euo pipefail
image=${1:?image uri}; port=${2:?container port}; shift 2
: "${EXECUTION_ROLE_ARN:?}"; : "${INFRA_ROLE_ARN:?}"
exec aws ecs create-express-gateway-service \
  --primary-container "image=${image},containerPort=${port}" \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --infrastructure-role-arn "$INFRA_ROLE_ARN" \
  "$@"
