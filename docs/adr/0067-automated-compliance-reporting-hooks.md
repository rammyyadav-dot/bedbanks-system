# ADR 0067: Automated compliance reporting hooks

Status: Accepted. Partly implemented; the "Not built" section is the honest boundary of what this change delivers.

## Context
Administration & Governance already writes an append-only audit trail (`AuditEvent`, insert-only for every application role, ADR 0032) and shows read-only access reviews. What it lacked was compliance *reporting*: evidence of RBAC changes, privileged access, denials, tenant governance decisions, bulk data exports, financial controls and cross-border bookings that (a) cannot be skipped by a code path that forgets to call a hook, (b) is tamper-evident, and (c) leaves the primary database for storage nobody in the platform can rewrite.

Constraints: tenant identity from server context only (1); never log credentials or guest PII (7); privileged and financial mutations create immutable audit events (8); supplier and infrastructure failures are observable (5); no placeholder presented as a capability (10); a reviewed forward migration with rollback notes, forced RLS and tenant-leading indexes; no new grant to the API runtime role.

## Decision
**1. Capture in the database, not in services.** An `AFTER INSERT` trigger on `AuditEvent` (`AuditEvent_compliance_capture`) classifies the action and, for a compliance-relevant one, appends an immutable `ComplianceRecord` in the same transaction. Every writer of the audit log (the API role, the booking role, the hold-expiry role, platform administration, bootstrap) is covered without a code change, and a rolled-back mutation leaves no record. The trigger function is `SECURITY DEFINER`, so no writer role gets a privilege on the compliance tables. It fails closed: if capture fails, the audit insert and with it the mutation fail.

**2. One classification, generated into SQL.** `apps/api/src/compliance/compliance-classification.ts` maps 42 actions to seven categories: `RBAC_CHANGE`, `PRIVILEGED_ACCESS`, `ACCESS_DENIAL`, `TENANT_GOVERNANCE`, `DATA_EXPORT`, `FINANCIAL_CONTROL`, `BOOKING_JURISDICTION`. The SQL classifier `fbeds_compliance_category()` is generated from it; a spec fails when the latest migration defining it differs, and another fails when a classified action no longer has a writer in the source (a renamed action would otherwise silently stop being captured). Authentication events (login, logout) are deliberately excluded: they are high volume, tenantless, and belong to the edge/SIEM pipeline.

**3. Record contents.** The audit event id, tenant (NULL for platform events), category, action, entity, actor, time and the already-sanitised audit payload, plus `payload_sha256` (SHA-256 of the payload's jsonb text). For booking events the trigger adds the buyer's country (the agency) and the destination country (the hotel), and `cross_border`; it is NULL when either is unknown, never guessed. No guest data is read or stored.

**4. Hash-chained export to WORM storage.** A separate exporter (`pnpm --filter @bedbanks/api ops:compliance export`) runs on a schedule as the dedicated role `fbeds_compliance` and works per scope (a tenant id, or `platform`):
- **seal**: under a per-scope advisory lock, the next records (oldest first, up to 1,000) become a `ComplianceExportBatch` whose `batch_sha256` covers the scope, sequence, record count, time range, the SHA-256 of the canonical NDJSON body, and the previous batch's hash (genesis: 64 zeros). Unique `(scope_key, sequence)` and unique `record_id` make a concurrent exporter fail rather than fork the chain or export a record twice.
- **store**: the body is re-rendered from the immutable records and re-checked against the sealed hashes, then written with a JSON manifest to S3 with Object Lock in `COMPLIANCE` mode (seven-year default retention, minimum 365 days), an S3-verified SHA-256 checksum and `If-None-Match: *`. Only then does the batch flip `SEALED -> STORED`. A batch left `SEALED` by a crash or an outage is stored first on the next run, with the same hash.
- Record-, membership- and batch-level triggers refuse UPDATE and DELETE (even for the owner); the only permitted change is `SEALED -> STORED` once.
- The exporter reports a failing scope and exits non-zero; it never skips one silently.

**5. Independent verification.** `ops:compliance verify` walks every scope's chain from the archive alone (body hashes, payload digests, record order and scope, sequence continuity, links), then cross-checks the database: every stored batch is in the archive with the same hash, the archive holds no batch the database does not know, no record fell behind the exported chain, and no record waited longer than the allowed lag (default 24 h). The same checks can be run by an external auditor with only the archive and any SHA-256 tool; the format is documented in the runbook.

**6. Isolation and privileges.** All three tables have forced RLS: tenant rows are visible only in their tenant, platform rows only in a transaction that set `app.compliance_scope = 'platform'`; records are insertable only while the trigger has set its transaction-local flag. `fbeds_compliance` holds SELECT on the three tables, INSERT on the two batch tables, UPDATE on `storage_status, stored_at, object_version_id` only, and EXECUTE on two SECURITY DEFINER functions that return scope keys only. It cannot read `AuditEvent`, bookings, users or money tables (verified by `ops:compliance verify-role`). The API runtime role holds nothing on the new tables; the contract lists them as privileged paths.

## Consequences
- Every classified audit insert now also writes one row and one SHA-256 over the payload in the same transaction. The trigger takes no lock beyond the row insert; chaining happens asynchronously in the exporter, so hot paths (booking confirmation) do not serialise on a chain head.
- Classification changes are a migration (regenerated function) plus the TypeScript change, enforced by the spec.
- Compliance records have no foreign key to tenants: evidence outlives a deleted tenant and does not block its deletion.
- The scope discovery functions read the compliance tables as their owner. Like `fbeds_booking_due_tenants`, they rely on the migration owner bypassing RLS (the observed production owner has BYPASSRLS, see `docs/prod-schema-compatibility-certification-2026-09-27.md`). The capture trigger does not depend on this: it inserts under its own policy and reads booking countries in the writer's own tenant.
- The exporter refuses a filesystem archive unless the database is local, and refuses an S3 bucket without Object Lock enabled.

## Not built
- **Infrastructure.** Built by amendment 2 below, off by default. Until the owner enables it and provisions the role, nothing is exported, and records accumulate in the database (still captured and immutable).
- **Admin UI / API.** Built by amendment 1 below.
- **External anchoring** of the chain head beyond Object Lock (for example a periodic signed timestamp) and **report generation** (per-regulator summaries) are not built.

## Rollback
Forward migration, reviewed before use, while the exporter is stopped; listed in the header of `202611200001_compliance_reporting_hooks`. Dropping the trigger restores the previous audit behaviour exactly. Archived objects remain in WORM storage for their retention period by design.

## Amendment 1: Admin compliance evidence (read surface)
**Decision.** Administration & Governance gets a read-only **Compliance evidence** module under Risk & Compliance (`/compliance`), backed by two tenant-scoped endpoints declared in `@bedbanks/contracts` (`routes.admin.operations.complianceSummary`, `complianceRecords`):
- `GET /admin/operations/compliance/summary?days=1..90` returns the records captured in the window per category (every category present), the jurisdiction split of booking events (cross-border, domestic, unknown), and the all-time export chain: batch count, stored, sealed but not stored, head sequence and hash, last stored time, and how many records are still pending (and the oldest pending one). The export section is `unavailable` (never zero) if the role cannot read it.
- `GET /admin/operations/compliance/records` returns a paged list, newest first, filterable by category, export state (`PENDING`, `SEALED`, `STORED`), cross-border, action text (LIKE-escaped) and day range. Each row shows the payload's SHA-256, never the payload itself. The Audit explorer remains the place to read payloads.
- **Permission:** `audit.read`, the same authority as the Audit explorer and Access reviews, since the evidence is derived from the same audit trail. No new permission row. A refused request is itself captured as an `ACCESS_DENIAL` record (asserted in the e2e).
- **Database:** following repository rule SR-07, the grant is stated only in `runtime-role-contract.ts` and applied by `ops:provision-api-runtime-role`, not by a migration. The API role gets column-level SELECT on `ComplianceRecord` (every column except `payload`) and SELECT on `ComplianceExportBatch` and `ComplianceExportBatchRecord`. It still has no write on any compliance table. Forced RLS limits every read to the active tenant; platform (tenantless) records are never visible through the API.

**Evidence.** `apps/api/test/compliance-evidence.e2e-spec.ts` runs the whole application as the provisioned strict runtime role. It covers:
- the 401 and 403 gate;
- per-category, jurisdiction and export-chain counts after a real export;
- tenant and platform isolation;
- the absence of the payload, both in responses and as a database privilege;
- every filter, and rejection of invalid ones.

`apps/admin/lib/admin-mvp-guards.test.ts` asserts that the page uses the two endpoints, renders an unavailable section as unavailable, performs no arithmetic or mutation, and is gated by `audit.read` in navigation.

**Rollout.** Re-run `ops:provision-api-runtime-role` (owner) after deploying, so the role receives the three read grants. Until then, the summary answers with its export section `unavailable` and the list answers `503 OPERATIONS_READ_DENIED`. Neither shows an empty result.

**Still not built:** external anchoring of the chain head and per-regulator reports. Terraform is in amendment 2.

## Amendment 2: AWS infrastructure (Terraform)
**Decision.** `infra/aws/terraform/compliance.tf` provisions the archive and the schedule behind `compliance_export_enabled` (default `false`), so no environment changes until an owner opts in.
- **Archive.** S3 with Object Lock enabled at creation, default retention COMPLIANCE for `compliance_retention_days` (default 2557, validated to be at least 365, matching the exporter's minimum). Versioning on, public access blocked, bucket-owner-enforced ownership. SSE-KMS with a dedicated key (rotation on) and bucket keys. Lifecycle only aborts incomplete uploads; nothing expires. The bucket policy denies non-TLS access, denies `DeleteObject` and `DeleteObjectVersion` to every principal (Object Lock alone would still allow delete markers, which hide a batch), and denies any `PutObject` that does not carry COMPLIANCE retention.
- **Least privilege.**
  - Execution role: may read only the `COMPLIANCE_DATABASE_URL` secret shell (value set out of band, like every runtime URL).
  - Task role: may `PutObject`, `PutObjectRetention` and `GetObject` under `compliance/*`, `ListBucket` and `GetBucketObjectLockConfiguration` on the bucket, and use the compliance key. No delete, no bypass, no wildcard action.
  - Security group: the new `compliance` group reaches Postgres (5432 to `data`) and HTTPS only, and has no ingress. S3 is reached through the existing gateway endpoint.
- **Schedules.** EventBridge Scheduler runs the API image's `ops:compliance export` every 15 minutes and `verify` hourly, on Fargate in private subnets without a public IP. The schedule definitions are encrypted with the compliance key. The scheduler role may only `ecs:RunTask` the two compliance families on this cluster and pass their two roles. Targets name the task family without a revision, so they always run the latest revision.
- **Deploy.** `aws-deploy.yml` registers a compliance task revision with the same image digest whenever it deploys `api` (skipped when the families do not exist). The CI deploy role gains `iam:PassRole` for the two compliance roles only; it still has no `ecs:RunTask`.
- **Observability.** A log metric filter on `/fbeds/<env>/compliance` counts `FAIL:` lines, crashes and refused database identities, and alarms on any. Heartbeat filters count successful exports and verifications; their alarms treat missing data as breaching (45 minutes and 2 hours), so a stopped schedule or a task that cannot start also pages the existing alarm topic.

**Evidence.**
- `terraform validate` and `terraform fmt -check` pass.
- The offline plan tests in `tests/governance.tftest.hcl` pass, 20 in total, including three new ones:
  - off by default;
  - WORM, least-privilege and monitored when enabled: the assertions cover Object Lock, COMPLIANCE retention, no delete or wildcard in the task role, the deny statements, the schedule rates, no public IP, breaching heartbeats, and the single secret;
  - retention below 365 days is refused.
- `tools/aws-governance-check.mjs` passes, and checkov 3.2.0 with the repository baseline reports 427 passed and 0 failed, with no new exception. CKV_AWS_297 (schedules using a customer-managed key) was fixed rather than skipped.
- Nothing was applied to an AWS account.

**Consequences.** Enabling the archive in an environment commits it to keep every archived object for the retention period. Nobody, root included, can delete them before then, and the bucket survives `terraform destroy`. This is the purpose of WORM storage, and it is why the module is opt-in and the runbook says it twice.

