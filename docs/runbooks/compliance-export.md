# Runbook: compliance export (ADR 0067)

Compliance records are captured automatically by the database whenever a classified audit event is written. This runbook covers the owner steps that make them leave the database for WORM storage, and how to verify the archive.

## 1. Owner steps (once per environment)
The AWS side is in Terraform (`infra/aws/terraform/compliance.tf`, ADR 0067 amendment 2) and is **off by default**.

1. Deploy migration `202611200001_compliance_reporting_hooks` with the normal reviewed migration process.
2. Provision the database role (owner connection; prints no secret):
   ```sh
   PROVISION_DATABASE_URL=<owner URL from the secret manager> \
   COMPLIANCE_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:compliance provision [--allow-remote --confirm-database=<name>]
   ```
3. Decide the retention. `compliance_retention_days` (default 2557, i.e. seven years; minimum 365) is the bucket's default COMPLIANCE retention, and the exporter's per-object date. **Objects under COMPLIANCE retention cannot be deleted by anyone, root included, until that date. The bucket outlives `terraform destroy` for that long.** Keep that in mind for staging.
4. Apply with `compliance_export_enabled = true` (and `compliance_retention_days` if not the default). This creates:
   - the Object Lock bucket (COMPLIANCE mode) with its own KMS key, TLS-only, deletes denied, and uploads denied unless they carry COMPLIANCE retention;
   - the `COMPLIANCE_DATABASE_URL` secret shell;
   - an execution role that can read only that secret, and a task role that can put, read and list the archive prefix only (never delete);
   - a `compliance` security group that can reach Postgres and HTTPS only;
   - two task definitions and the EventBridge Scheduler schedules (export every 15 minutes, verify hourly);
   - alarms on the existing alarm topic.
5. Set the secret value out of band, the same way as the other runtime URLs (never in Terraform):
   ```sh
   aws secretsmanager put-secret-value --secret-id "$(terraform output -raw compliance_database_url_secret_arn)" \
     --secret-string 'postgresql://fbeds_compliance_export:<password>@<db-host>:5432/<db>?schema=public&sslmode=require'
   ```
6. Deploy the API once (`aws-deploy.yml`, service `api`). The deploy registers a compliance task revision with the same image digest. The schedules always run the latest revision, so later deploys keep them on the current image with no further step.
7. Check the role from inside the VPC: run the `fbeds-<env>-compliance-verify` task once by hand with the command override `["node","--no-experimental-strip-types","-r","@swc-node/register","src/compliance/compliance-ops.cli.ts","verify-role"]`.

Until step 5 is done, every scheduled task fails to start (ECS refuses a task whose secret is empty) and the heartbeat alarms fire. That is intended: nothing fails silently.

## 2. Scheduled run
Terraform sets these on the task definitions:

| Variable | Value |
| --- | --- |
| `COMPLIANCE_DATABASE_URL` | the compliance role, from Secrets Manager. Never the owner or the API role; the CLI refuses a superuser, BYPASSRLS or owner login |
| `COMPLIANCE_ARCHIVE_BUCKET` | the Object Lock bucket |
| `AWS_REGION` | the bucket's region |
| `COMPLIANCE_RETENTION_DAYS` | `compliance_retention_days` |
| `COMPLIANCE_BATCH_SIZE` | optional, default 1000, maximum 5000 (not set by Terraform) |
| `COMPLIANCE_MAX_LAG_HOURS` | optional (verify), default 24 (not set by Terraform) |

Outside AWS, the same commands run by hand:
```sh
pnpm --filter @bedbanks/api ops:compliance export   # exit 1 when any scope failed
pnpm --filter @bedbanks/api ops:compliance verify   # exit 1 on any chain, archive or coverage problem
```
Output contains scope ids, sequences, hashes and object keys only (log group `/fbeds/<env>/compliance`).

**Alarms** (SNS topic `fbeds-<env>-alarms`):
- `fbeds-<env>-compliance-failure`: any `FAIL:` line, a crash, or a refused database identity.
- `fbeds-<env>-compliance-export-missing`: no successful export run in 45 minutes.
- `fbeds-<env>-compliance-verify-missing`: no successful verification in 2 hours.

Missing data counts as breaching, so a stopped schedule or a task that never starts also pages.

`COMPLIANCE_ARCHIVE_DIR=<dir>` replaces the bucket for local development. It is refused for a non-local database, because a filesystem is not WORM storage.

## 3. Failures
| Message | Meaning | Action |
| --- | --- | --- |
| `Bucket ... does not have S3 Object Lock enabled` | wrong bucket | fix configuration; nothing was written |
| `scope X: ... (P2034)` or another error class | database or network failure for one scope | other scopes continued; the next run retries. A sealed batch is stored first on the next run, with the same hash |
| `Archive object ... already exists with different content` | an object with this batch's key holds other bytes | **security incident**: stop the schedule, preserve evidence, do not retry |
| `... no longer matches its sealed hash` | records or batch rows changed after sealing | **security incident**: the database triggers forbid this, so it implies owner-level tampering |
| `fell behind the exported chain` | a record committed more than 24 h after newer records were exported | investigate the long transaction; the record is still in the database and must be exported by an owner-reviewed one-off batch |
| `waited longer than the allowed export lag` | the exporter is not running or is failing | restore the schedule |

## 4. Viewing evidence in Admin
Risk & Compliance → **Compliance evidence** (`/compliance`, permission `audit.read`) shows each tenant's captured records, their export state (not yet exported / sealed / stored), and the head of its chain. That head is the same hash `ops:compliance verify` prints. After deploying ADR 0067 amendment 1, re-run `ops:provision-api-runtime-role` so the API role can read the compliance tables (column-level; never the payload).

### Period reports
Compliance evidence → **Period report** downloads every record of a period (at most 366 days and 20,000 records), as CSV or JSON, with counts, export coverage, booking corridors and an attestation:
- `recordsSha256` is the SHA-256 of `<id>\t<payloadSha256>\n` per record, oldest first.
- For stored records, the same lines come from the archived batch bodies (section 5), so an auditor can check the report against WORM storage.
- Each download is audited as `compliance.report.exported` and captured as `DATA_EXPORT` evidence.
- A larger period answers `COMPLIANCE_REPORT_TOO_LARGE`: choose a shorter one.

### Signed checkpoints
With `compliance_export_enabled`, the tasks receive `COMPLIANCE_SIGNING_KEY_ID`, the KMS key `alias/fbeds-<env>-compliance-signing`. After each export, a checkpoint of every scope's stored head is signed and archived under `compliance/checkpoints/v1/`, and `verify` checks all of them.

| Message | Meaning | Action |
| --- | --- | --- |
| `checkpoint ...: signature is not valid` or `hash does not match its content` | a checkpoint object was altered | **security incident**, as for an altered batch |
| `head <scope>#n is not in the archived chain` | a signed head is not what the archive holds | **security incident**: the chain was rebuilt after it was signed |
| `head of <scope> moved back` | a later checkpoint commits to an older head | **security incident** |
| `signed by an unexpected key` | a checkpoint was signed with a key other than the configured one | expected only after a key rotation; otherwise a security incident |
| `signing is configured but the archive holds no checkpoint` | export has not run since signing was enabled, or it fails | check the export task and its `FAIL: checkpoint` lines |

**Rotating the signing key.** Asymmetric KMS keys do not rotate automatically.
1. Create a new key, and point the alias, or `COMPLIANCE_SIGNING_KEY_ID`, at it.
2. The next export archives the new public key and signs with it.
3. Until every checkpoint is signed by the new key, `verify` reports earlier ones as signed by an unexpected key. Record the old key's fingerprint in the change ticket.
4. Keep the old key enabled for `GetPublicKey` only, or rely on the archived PEM.

**Offline check by an auditor.** Recompute the SHA-256 of the canonical checkpoint body, which is `checkpointSha256`. Then verify `signature` (base64, DER ECDSA) over the same bytes with the archived PEM, for example:

```sh
openssl dgst -sha256 -verify key.pem -signature sig.der body.json
```

## 5. Archive format (for auditors)
Keys: `compliance/v1/<scope>/<sequence, 10 digits>-<first 16 hex of batch hash>.ndjson` and the same key ending `.manifest.json`. `<scope>` is a tenant id or `platform`.

Body: one JSON object per line, `\n`-terminated, keys in this order: `v, id, tenantId, category, action, entityType, entityId, actorType, userId, occurredAt, payloadSha256, payloadText, originCountry, destinationCountry, crossBorder`. `sha256(payloadText) = payloadSha256`, and `payloadText` is exactly the audit payload as stored. Lines are ordered by `occurredAt`, then `id`.

Batch hash = SHA-256 of the UTF-8 text (each line ending in `\n`):
```
fbeds-compliance-batch/v1
scope=<scope>
sequence=<n>
previous=<batch hash of n-1, or 64 zeros for n=1>
body=<SHA-256 hex of the body object>
records=<line count>
first=<occurredAt of the first line>
last=<occurredAt of the last line>
```
A chain is valid when sequences run 1..N without a gap, each manifest's `previous` equals the preceding `batchSha256`, and every hash above recomputes. The head hash of each scope is printed by `ops:compliance verify`; recording it in an external system (ticket, email) anchors the chain at that point in time.
