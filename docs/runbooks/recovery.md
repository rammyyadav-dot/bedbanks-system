# Recovery and operational readiness

Companion to `rollback.md` (code rollback) and `aws-ecs-deployment.md` (rollout).

## Promotion gates (enforced in `.github/workflows/aws-deploy.yml`)

1. The `Promotion gate` job fails unless the five release checks from `ci.yml` (Schema integrity, Prisma migration certification, verify, End-to-end release suite, Website production checks) are green on the exact SHA. Rename a CI job and you must rename it in the gate.
2. Production additionally requires the SHA to be on `main` and to have a successful staging deployment. Deploy to staging first and verify it.
3. The deploy job (behind the GitHub environment's required reviewers) fails if ECS circuit-breaker rolled the service back, or if the service ends with unfinished deployments or missing tasks.
4. Migrations are never run by the deploy; they remain an owner-run step.

## Shutdown behaviour

On SIGTERM the API reports `GET /api/v1/health/ready` as 503, finishes in-flight requests, then Nest runs `onModuleDestroy` (hold-expiry sweeper, supplier runner, database pools). The container runs `node` directly so the signal is delivered to it. The ECS `stopTimeout` is 30s; a request longer than that is killed. Note: Terraform sets the task definition only for revision 1 (`ignore_changes`), so changing `stopTimeout` needs a new task definition revision, not only a Terraform apply.

## Alarms (SNS topic `<env>-alarms`; subscribe `alarm_email` or the on-call route)

Unhealthy targets, API 5xx, no healthy targets (missing data counts as breaching), RDS CPU and free storage. Confirm after each environment apply that the topic has a confirmed subscriber; an alarm with no subscriber is not monitoring.

## Recovery

- **Bad release:** run `AWS deploy` with the previous known-good SHA for the affected service. Do not drop database objects.
- **Data loss or corruption:** RDS automated backups keep 14 days with point-in-time restore. Restore to a NEW instance, validate, then repoint the `DATABASE_URL` secrets; never restore over the live instance. Production has deletion protection and a final snapshot.
- **Restore drill:** at least once per quarter and before go-live, restore a staging snapshot to a new instance, run `prisma:migrate:status` and the tenant-control certification against it, and record the date, duration and result in `docs/evidence`. A backup that has never been restored is unverified.
- **Credential exposure:** follow `incident-response.md` and `docs/aws-secret-rotation-runbook.md`.
- **Logical dump caveat:** `pg_dump` of one database carries no roles. A dump restored with `--no-owner` into a cluster missing the runtime and ops roles silently drops their grants; create the roles first (`pg_dumpall --globals-only`, or the `ops:provision-*` commands) and re-run the strict-role certification. RDS snapshot and point-in-time restores keep roles.
- **Local rehearsal:** `SOURCE_URL=postgresql://…@localhost:…/<db> tools/ops/restore-drill.sh` dumps a disposable database, restores it beside the source and fails unless table row counts, forced-RLS tables, policies and the migration ledger match. It refuses non-loopback hosts. Latest evidence: `docs/release-hardening-certification-2026-10-30.md`.
