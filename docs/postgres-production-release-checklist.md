# PostgreSQL production release checklist

This evidence template must be completed by the database owner. It is not proof of approval by itself.

## Platform role-management migration gate

Migration under review: `202609230001_platform_role_management_permissions`

The owner must complete one row for every persistent database discovered from approved infrastructure configuration and owner records. Repository files are not a complete environment inventory. Include production, staging, shared preview, shared development, and any customer- or tenant-specific persistent database where applicable. Do not include disposable CI databases as production evidence.

| Environment / database | Owner | `_prisma_migrations` state | Migration checksum | Applied at / finished at | Failure details | Evidence reference | Owner decision |
|---|---|---|---|---|---|---|---|
| Production | Pending owner identification | NOT EXECUTED | Pending | Pending | Pending | Pending | Pending |
| Staging | Pending owner identification | NOT EXECUTED | Pending | Pending | Pending | Pending | Pending |
| Shared preview | Pending owner identification | NOT EXECUTED | Pending | Pending | Pending | Pending | Pending |
| Shared development | Pending owner identification | NOT EXECUTED | Pending | Pending | Pending | Pending | Pending |
| Other persistent databases | Pending owner identification | NOT EXECUTED | Pending | Pending | Pending | Pending | Pending |

Read-only evidence must include the migration name, `checksum`, `started_at`, `finished_at`, `applied_steps_count`, and `logs` for the target migration. Keep connection strings, credentials, raw sensitive output, and secret values out of Git and pull requests. Attach evidence through the approved private release channel and record only its reference here.

If the migration is `failed`, the checksum differs from the committed file, or the history is missing/divergent, stop. Do not run `migrate resolve`, edit historical migrations, reset, or guess a repair; escalate the exact discrepancy to the database owner.

## Controlled rollout and recovery approval

Before an approved window, the database owner must record: verified backup identifier and restore test; migration and application order; smoke and verification queries; compatibility confirmation for old and new application versions; maintenance window; forward-fix owner; recovery/restore owner; abort criteria; monitoring; and explicit approval. Recovery is forward-only unless the owner authorizes a verified restore. Do not drop objects or hand-edit `_prisma_migrations`.

Owner approval decision: **Pending**

Approval owner: **Pending**

Approved window: **Pending**

Recovery point / backup: **Pending**

## Current gate status

No persistent database was accessed by this audit. No migration was applied, resolved, reset, or pushed. A disposable PostgreSQL CI replay is not persistent-environment evidence.

| Gate | Owner evidence | Sign-off |
|---|---|---|
| `_prisma_migrations` matches the committed chain | Attach query output and release SHA | Pending |
| Backup and restore drill | Backup ID, restore time and verification | Pending |
| Engine, version and extensions | Approved PostgreSQL version/configuration | Pending |
| Non-owner HTTP role | No table ownership or `BYPASSRLS`; RLS tests recorded | Pending |
| RLS policies | Tenant A/B read and write negative tests | Pending |
| Connection pool | Transaction-local context and reset behaviour reviewed | Pending |
| Secrets | Stored only in approved secret manager | Pending |
| Monitoring and access audit | Alerts and database access logging enabled | Pending |
| Maintenance window | Window, forward-fix owner and rollback owner assigned | Pending |
