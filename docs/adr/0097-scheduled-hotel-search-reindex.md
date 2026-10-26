# ADR 0097: Scheduled hotel search reindex

## Status
Accepted. Builds the scheduler left open by ADR 0095 and 0096. Off by default (`hotel_search_reindex_enabled = false`): with the default, `terraform plan` adds only an unattached security group and its rules.

## Decision
`infra/aws/terraform/search-reindex.tf`, modelled on `compliance.tf`:
- One Fargate task from the API image running `ops:reindex-hotel-search --apply --fail-on-stale --allow-remote --confirm-database=<name>` on EventBridge Scheduler (default `rate(1 hour)`; the job is idempotent and writes nothing when nothing is stale).
- Credential: only `HOTEL_SEARCH_REINDEX_DATABASE_URL`, the narrow login of ADR 0096, from a Secrets Manager shell whose value is set out of band. The owner credential is never available to the task.
- The task role has no AWS permissions. The execution role reads that one secret and decrypts with the data key. The security group reaches Postgres (5432) and HTTPS only, with no ingress.
- The deploy workflow registers a matching task revision with each API image (`aws-deploy.yml`), and the deploy role may pass the two task roles (`iam.tf`), so the schedule always runs the deployed image. The deploy role still cannot run the task.
- Alarm: the CLI prints its JSON report only after it finishes; the metric filter counts `"appliedEqualsIndexable": true`. No success in 180 minutes (missing data is breaching) pages the existing alarm topic. A red run (exit 2 or 3) therefore alarms by absence.

## Enabling
1. Provision and certify the role (`docs/runbooks/hotel-search-reindex-role.md`), using the direct (non-pooled) endpoint.
2. Set `hotel_search_reindex_enabled = true` and `hotel_search_reindex_database_name`, apply, then put the secret value in the shell.
3. Run the task once by hand from the console and check the log group for the report and the heartbeat.

## Verification
`terraform fmt -check` and the repo's governance checks. Not verified here: `terraform validate`, `terraform test`, `checkov` and a plan, because the Terraform registry is unreachable from the authoring environment. CI's Terraform check must pass before merge. Not verified: that the metric filter pattern matches the pretty-printed JSON line in CloudWatch, and the task end to end on Neon.

## Rollback
Set `hotel_search_reindex_enabled = false` and apply (removes the schedule, task, roles, secret shell and alarm). The role stays; deprovision it per ADR 0096. Reverting the code leaves the manual reindex as before.
