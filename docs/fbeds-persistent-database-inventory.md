# fBeds Persistent Database Inventory — Owner Evidence

Status: **BLOCKED — provider resource identity and owner evidence required**

Release baseline: `9ebb08545681e98b19058bb302aeca5c79da28e7`

This document operationalizes `docs/postgres-production-release-checklist.md`. It is an evidence register, not approval. Do not place connection strings, passwords, tokens, or raw secret values in Git.

## Inventory

| Environment | Provider project | Branch | Database | Compute endpoint | Persistent? | Migration 202609230001_platform_role_management_permissions | Owner | Evidence ref | Decision |
|---|---|---|---|---|---|---|---|---|---|
| Production | Pending | Pending | Pending | Pending | Yes | NOT VERIFIED | Pending | Pending | BLOCKED |
| Staging | Pending | Pending | Pending | Pending | Yes | NOT VERIFIED | Pending | Pending | BLOCKED |
| Shared preview | Pending | Pending | Pending | Pending | Yes if shared/non-expiring | NOT VERIFIED | Pending | Pending | BLOCKED |
| Shared development | Pending | Pending | Pending | Pending | Yes | NOT VERIFIED | Pending | Pending | BLOCKED |
| Other persistent databases | Pending discovery | Pending | Pending | Pending | Pending classification | NOT VERIFIED | Pending | Pending | BLOCKED |

Disposable CI PostgreSQL is excluded from persistent-environment approval. Its successful migration replay/status/drift and E2E evidence does not prove any row above.

## Approved read-only Neon discovery

An authorized infrastructure/database owner supplies the fBeds Neon project ID(s). For each project, record metadata only:

1. List branches and classify each as persistent or disposable from provider lifecycle/settings and owner evidence; do not classify from branch name alone.
2. For each persistent branch, list PostgreSQL databases and compute endpoints.
3. Reconcile each resource with deployment environment-variable **names/references** and owner records. Do not export connection strings or secret values.
4. For each persistent database, execute only the following read-only migration-history query:

```sql
SELECT migration_name,
       checksum,
       started_at,
       finished_at,
       applied_steps_count,
       logs
FROM "_prisma_migrations"
WHERE migration_name = '202609230001_platform_role_management_permissions';
```

Record a sanitized evidence reference outside Git when logs contain sensitive material. If the row is missing, record **NOT APPLIED**. If checksum/history is divergent or a failed migration is present, STOP and escalate to the database owner. Do not run `migrate resolve`, `db push`, reset, edit migration history, or apply a migration.

## Role / RLS evidence

For each persistent application database, the owner must verify with read-only metadata that the HTTP role is non-owner, non-superuser and has no `BYPASSRLS`; RLS is enabled where required; transaction-local tenant context/pool reset behavior is approved; and privileged migration/background roles are separate.

Record only role names/attributes and evidence references approved for Git. Do not record passwords or connection strings.

## Owner-controlled evidence still required

- Complete provider inventory for production, staging, shared preview, shared development and any other persistent database.
- Database owner identity for every persistent resource.
- Exact `_prisma_migrations` evidence and committed-migration checksum comparison.
- Verified backup identifier and restore drill.
- PostgreSQL engine/version/extensions.
- HTTP role/RLS and connection-pool isolation.
- Secret-manager confirmation.
- Monitoring and database access logging.
- Approved deployment order and compatibility check.
- Maintenance window, abort criteria, forward-fix owner and recovery/restore owner.
- Explicit database-owner release decision.

## STOP conditions

Production migration/deployment remains blocked if any persistent database is undiscovered, owner evidence is missing, migration history/checksum is divergent or failed, backup/restore is unverified, HTTP role/RLS controls are not approved, or explicit owner approval is absent.

No persistent database migration or deployment is authorized by this document.
