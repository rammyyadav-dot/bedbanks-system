# Rollback runbook

Stop the rollout, identify the deployed version, and roll back **application code first**. Never drop database objects. Migrations are forward-only: for schema questions use the migration's own rollback notes, and restore from a verified backup only when required and approved by the owner.

## AWS ECS (staging and production)
1. Confirm what is running: ECS console, or `aws ecs describe-services --cluster fbeds-<env> --services <svc> --query 'services[0].taskDefinition'`.
2. Run the **AWS rollback** workflow (Actions → AWS rollback) from `main`: choose the environment (production needs the environment reviewers), the service, optionally a revision number, and a reason. Empty revision = the revision immediately before the running one.
3. The workflow refuses a revision that is not pinned to an image digest, waits for the service to be stable, and fails if the service did not settle on the target revision (an ECS circuit-breaker bounce is a failure, not a rollback). The run summary records who, why, and from/to revisions.
4. Roll back dependents in the reverse of deploy order: portals first, then the API. If the bad release included a migration the older code cannot run against, stop and escalate to the owner instead of rolling back.
5. Record the incident per `docs/runbooks/incident-response.md`; open a fix-forward pull request. Re-deploying the bad commit requires a new commit SHA.

## Not covered
- Database rollback (forward-only; see the migration's notes and `docs/runbooks/recovery.md`).
- Vercel-hosted portals during the migration period: use Vercel's instant rollback to the previous deployment (`docs/runbooks/vercel-deployment-topology.md`).
- Scheduled compliance tasks keep the revision registered by the last deploy; re-run AWS deploy for the older SHA if they must match.
