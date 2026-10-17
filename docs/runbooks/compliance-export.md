# Runbook: compliance export (ADR 0067)

Compliance records are captured automatically by the database whenever a classified audit event is written. This runbook covers the owner steps that make them leave the database for WORM storage, and how to verify the archive.

## 1. Owner prerequisites (once per environment)
1. Deploy migration `202611200001_compliance_reporting_hooks` with the normal reviewed migration process.
2. Create an S3 bucket **with Object Lock enabled at creation** (versioning on), in the platform's region, encrypted with a KMS key. Do not set a bucket default retention that is shorter than `COMPLIANCE_RETENTION_DAYS`; the exporter sets `COMPLIANCE` mode and a retain-until date on every object itself.
3. Give the exporter's task role `s3:PutObject`, `s3:PutObjectRetention`, `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketObjectLockConfiguration` on that bucket only. No `s3:DeleteObject*`, no `s3:BypassGovernanceRetention`.
4. Provision the database role (owner connection; prints no secret):
   ```sh
   PROVISION_DATABASE_URL=<owner URL from the secret manager> \
   COMPLIANCE_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:compliance provision [--allow-remote --confirm-database=<name>]
   ```
   Build `COMPLIANCE_DATABASE_URL` for `fbeds_compliance_export` and store it in the secret manager.
5. Check the role: `COMPLIANCE_DATABASE_URL=... COMPLIANCE_ARCHIVE_BUCKET=... pnpm --filter @bedbanks/api ops:compliance verify-role`.

## 2. Scheduled run
Run every 15 minutes (export), then hourly (verify), as a scheduled task with:

| Variable | Value |
| --- | --- |
| `COMPLIANCE_DATABASE_URL` | the compliance role (never the owner, never the API role; the CLI refuses a superuser, BYPASSRLS or owner login) |
| `COMPLIANCE_ARCHIVE_BUCKET` | the Object Lock bucket |
| `AWS_REGION` | the bucket's region |
| `COMPLIANCE_RETENTION_DAYS` | optional, default 2557 (7 years), minimum 365 |
| `COMPLIANCE_BATCH_SIZE` | optional, default 1000, maximum 5000 |
| `COMPLIANCE_MAX_LAG_HOURS` | optional (verify), default 24 |

```sh
pnpm --filter @bedbanks/api ops:compliance export   # exit 1 when any scope failed
pnpm --filter @bedbanks/api ops:compliance verify   # exit 1 on any chain, archive or coverage problem
```
Alert on a non-zero exit of either. Output contains scope ids, sequences, hashes and object keys only.

`COMPLIANCE_ARCHIVE_DIR=<dir>` replaces the bucket for local development; it is refused for a non-local database because a filesystem is not WORM storage.

## 3. Failures
| Message | Meaning | Action |
| --- | --- | --- |
| `Bucket ... does not have S3 Object Lock enabled` | wrong bucket | fix configuration; nothing was written |
| `scope X: ... (P2034)` or another error class | database or network failure for one scope | other scopes continued; the next run retries. A sealed batch is stored first on the next run, with the same hash |
| `Archive object ... already exists with different content` | an object with this batch's key holds other bytes | **security incident**: stop the schedule, preserve evidence, do not retry |
| `... no longer matches its sealed hash` | records or batch rows changed after sealing | **security incident**: the database triggers forbid this, so it implies owner-level tampering |
| `fell behind the exported chain` | a record committed more than 24 h after newer records were exported | investigate the long transaction; the record is still in the database and must be exported by an owner-reviewed one-off batch |
| `waited longer than the allowed export lag` | the exporter is not running or is failing | restore the schedule |

## 4. Archive format (for auditors)
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
