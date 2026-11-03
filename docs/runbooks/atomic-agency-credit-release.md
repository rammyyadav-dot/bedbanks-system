# Atomic agency credit release (ADR 0111)

This is an API-only release, with no new migration or production grant. Use the reviewed release commit throughout. Do not run the disposable test suite on staging or production data.

## Evidence before promotion

- The exact candidate commit passes CI, including `Prisma migration certification` (which now runs `test:credit:postgres`), architecture, type checks, lint, unit tests and the existing end-to-end release checks.
- Build `api` using the existing AWS images workflow on reviewed main. Record its immutable ECR digest and the currently serving ECS task definition for rollback.
- Verify the intended AWS account, ap-south-1 region, `fbeds-staging`/`fbeds-production` cluster and `api` service. The GitHub environment must have its existing AWS OIDC role variables and production reviewer rules configured.
- Confirm the live database migration status is current and its runtime login passes `docs/runbooks/strict-role-rollout.md` identity/grant checks. Finance remains gated by the existing role contract; do not grant financial privileges to the API just to make a smoke test pass.

## Staging

1. Run the existing Deploy workflow for staging with `services=api` and the full reviewed SHA. No migration confirmation is needed for this patch; any unrelated pending migration is a separate blocker.
2. Follow `docs/runbooks/aws-ecs-deployment.md` for the HTTPS readiness and authentication checks. Confirm all desired tasks serve the new digest, there is one completed deployment, and no circuit-breaker rollback occurred.
3. With approved synthetic staging fixtures and an authorized financial execution role, verify a reservation/replay/release and an approved credit-limit reduction. Check ledger/audit counts and tenant-denied access. Inspect for PostgreSQL deadlocks, lock timeouts and unexpected 5xx. Preserve evidence with the deployment record.
4. Require a successful staging deployment of this same SHA before requesting production promotion. The existing AWS gate must remain enabled.

## Production window

Old replicas do not participate in the full agency lock protocol. An ordinary rolling deployment temporarily mixes protocols. Before replacing tasks, pause admission to new holds, authorizations, direct debits and credit-limit execution through the existing operational maintenance control, and drain in-flight financial transactions. Verify that the pause is effective. If no tested maintenance mechanism exists, stop here and schedule a controlled API maintenance window; do not assume a rolling restart makes the protocol atomic.

Run the existing Deploy workflow for production, `services=api`, the same staged SHA/digest, and the configured environment review. Wait until ECS reports all desired tasks on the new task definition and only one completed deployment. Verify HTTPS readiness, authenticated API access and restricted database identity before resuming financial admission. Production verification is read-only unless approved synthetic accounts are available; never manufacture bookings or move customer funds for a smoke test.

Record commit, ECR digest, old/new task definitions, staging/production run URLs, migration/role verification, pause/drain/resume times, health and alarm observations. Monitor deadlocks, lock waits, booking failures and 5xx through the release observation window.

## Rollback

Keep financial admission paused or pause/drain it again. Roll the API back to the recorded previous immutable image using the existing AWS workflow and verify every task and readiness before reopening admission. A code rollback restores the prior concurrency gap; document that limitation. No schema rollback applies. Do not bypass a failed CI/promotion/environment gate, alter runtime grants, or apply unrelated migrations as part of this patch.
