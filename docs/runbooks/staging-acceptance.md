# Staging acceptance

The exit gate is open until engineering, operations, security and product owners each sign the same SHA that was deployed to staging. A pull request, a local drill, or this runbook does not sign it.

## What a pull request can prove

`node tools/ops/run-staging-acceptance.mjs` runs, against disposable loopback PostgreSQL only:

- architecture and dependency gates
- SLI unit tests and the operational tool tests
- `test:security` (tenant isolation and authorization, on the strict runtime login)
- inventory hold concurrency and booking confirmation idempotency
- `tools/ops/restore-drill.sh`
- the incident-response tabletop
- the privacy log review
- a bounded hybrid-search load, recorded against the 200 ms budget

The runner refuses a non-loopback `ACCEPTANCE_DATABASE_URL`. It writes a JSON report and exits 0 when those checks finished, including when the search budget or the sign-off gate failed. Pass `--require-signoff` to exit 2 while the gate is open.

The security certification reads roles for the whole PostgreSQL cluster. Run it on a cluster whose only superuser is the disposable owner. A shared development cluster that already has other superuser roles fails the catalog check even when the application is unchanged.

## Deploy the candidate

Staging deploys the commit CI verified on `main` (ADR 0090). This does not run from a feature branch.

1. Merge the candidate. Confirm `STAGING_PIPELINE_ENABLED` is `true` and the AWS foundation exists. If the variable is unset, the deploy workflow plans nothing.
2. If the commit adds a Prisma migration, the pipeline builds images and stops. The owner runs `scripts/ecs-migrate.sh staging <sha>`, then re-dispatches **Staging release** with that SHA and `migrations_applied` true.
3. After the deploy is green, run the smoke URL if `STAGING_SMOKE_URL` is set. Confirm the alarm topic has a confirmed subscriber (a test alarm delivered to that mailbox). Apply `sli.tf` with the rest of the stack so the operations dashboard and SLI alarms exist. Record the deployment id, image digests and SHA in the acceptance report. Do not paste credentials.

RDS snapshot restore to a new instance, and an AWS rollback drill, stay owner-run (`docs/runbooks/recovery.md`, `docs/runbooks/rollback.md`). The loopback logical drill does not replace them.

## Sign

Create `docs/ops/staging-acceptance-signoff.json` (do not commit a signature you did not make):

```json
{
  "sha": "<40-character SHA that staging is running>",
  "signatures": [
    { "role": "engineering", "name": "<person>", "signedAt": "2026-11-04T18:00:00+05:30", "statement": "I accept the staging evidence for this SHA." },
    { "role": "operations", "name": "<person>", "signedAt": "2026-11-04T18:00:00+05:30", "statement": "I accept the staging evidence for this SHA." },
    { "role": "security", "name": "<person>", "signedAt": "2026-11-04T18:00:00+05:30", "statement": "I accept the staging evidence for this SHA." },
    { "role": "product", "name": "<person>", "signedAt": "2026-11-04T18:00:00+05:30", "statement": "I accept the staging evidence for this SHA." }
  ]
}
```

`node tools/ops/staging-signoff.mjs --sha <sha>` prints `OPEN` or `SIGNED`. Four distinct people, one per role, the exact statement, and the deployed SHA are required. The search budget, the restore drill and a recorded staging deploy must also be clear before anyone treats the gate as closed. Product and security signatures are not legal approval of the privacy notice (`privacyPolicyApproved` stays false).
