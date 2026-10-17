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
- **Infrastructure.** No Terraform for the Object Lock bucket, its KMS key or the scheduled ECS task is included. Until the owner provisions the bucket, the role and the schedule, nothing is exported and records accumulate in the database (still captured and immutable).
- **Admin UI / API.** There is no Admin screen or HTTP endpoint for compliance records or export status; the existing Audit and Access review screens are unchanged. Such a read surface needs its own contract in `@bedbanks/contracts`, a permission and a runtime-role read grant.
- **External anchoring** of the chain head beyond Object Lock (for example a periodic signed timestamp) and **report generation** (per-regulator summaries) are not built.

## Rollback
Forward migration, reviewed before use, while the exporter is stopped; listed in the header of `202611200001_compliance_reporting_hooks`. Dropping the trigger restores the previous audit behaviour exactly. Archived objects remain in WORM storage for their retention period by design.
