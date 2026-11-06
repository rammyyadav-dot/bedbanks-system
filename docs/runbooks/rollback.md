# Rollback runbook

Stop the rollout, identify the deployed version, and roll back **application code first**. Never drop database objects. Migrations are forward-only: for schema questions use the migration's own rollback notes, and restore from a verified backup only when required and approved by the owner.

## AWS ECS (staging and production)
1. Confirm what is running: ECS console, or `aws ecs describe-services --cluster fbeds-<env> --services <svc> --query 'services[0].taskDefinition'`.
2. Run the **AWS rollback** workflow (Actions → AWS rollback) from `main`: choose the environment (production needs the environment reviewers), the service, optionally a revision number, and a reason. Empty revision = the revision immediately before the running one. The workflow checks out this repository and runs `tools/ops/ecs-rollback.sh`.
3. The script refuses a revision that is not pinned to an image digest, waits for the service to be stable, and fails if the service did not settle on the target revision (an ECS circuit-breaker bounce is a failure, not a rollback). The run summary records who, why, and from/to revisions. `node --test tools/ops/ecs-rollback.test.mjs` runs that script against a stub AWS CLI. That certifies the procedure. It does not move a live service.
4. Roll back dependents in the reverse of deploy order: portals first, then the API. If the bad release included a migration the older code cannot run against, stop and escalate to the owner instead of rolling back.
5. Record the incident per `docs/runbooks/incident-response.md`; open a fix-forward pull request. Re-deploying the bad commit requires a new commit SHA.

## Abort thresholds (decision: incident commander)

Stop the rollout and run this runbook when any of the following holds for five consecutive minutes after the new revision is serving traffic:

| Signal | Abort if |
|---|---|
| API 5xx (`HTTPCode_Target_5XX_Count`) | more than 20 in 5 minutes |
| API p95 target latency | above 750 ms |
| Healthy host count | 0 (the no-healthy-hosts alarm already pages) |
| RDS CPU | above 80 % while error rate is also rising |
| Circuit breaker | ECS rolled the service back by itself — treat as a failed deploy, not a successful rollback |

Owner of the abort decision: the incident commander named in `incident-response.md`. Operator runs the AWS rollback workflow. Do not abort solely on a single spike with no customer-facing errors.

## Verify after rollback (target: under 5 minutes)

1. `GET /api/v1/health` returns 200 and `GET /api/v1/health/ready` returns 200.
2. Sign-in cookie still authenticates (one synthetic account).
3. Agent search for a known fixture hotel still returns contracted offers (booking remains fail-closed unless the owner enabled it).
4. `prisma:migrate:status` still matches this commit's chain — rollback never drops schema. If the aborted release applied a migration the previous image cannot run, **do not** roll the API back; restore or roll forward per `recovery.md`.

## Not covered
- Database rollback (forward-only; see the migration's notes and `docs/runbooks/recovery.md`).
- Vercel-hosted portals during the migration period: use Vercel's instant rollback to the previous deployment (`docs/runbooks/vercel-deployment-topology.md`).
- Scheduled compliance tasks keep the revision registered by the last deploy; re-run AWS deploy for the older SHA if they must match.
