# fBeds — Production Migration Repair Runbook

Status: **PREPARED — Production not yet mutated**

Release baseline: `71f5014767ca7aedeee68fe76f891de64d8d1b19`

## Purpose

Move the persistent Production database from the currently verified migration state through the five committed missing migrations while preserving authoritative Prisma migration history.

## Preconditions

All must be satisfied before execution:

1. Database owner explicitly approves the migration window.
2. Backup/recovery point and restore procedure are verified.
3. The migration runner has access to the exact release SHA.
4. `DATABASE_URL` points to the intended Production database.
5. The runtime HTTP role is confirmed non-owner, non-superuser and without `BYPASSRLS`.
6. Production booking remains disabled.
7. No concurrent schema-changing deployment is running.

## Preflight

Run read-only checks first:

```sql
SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
ORDER BY started_at;
```

Expected last successful migration before repair:

`202609220001_supply_permissions`

Historical unsuccessful rows for platform admin/catalogue must remain formally rolled back.

## Approved migration path

Use the repository's normal Prisma runner from the exact release SHA:

```sh
cd apps/api
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:status
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
pnpm prisma:migrate:drift
```

Do not run `db push`, `migrate reset`, manual migration SQL, or manual edits to `_prisma_migrations`.

## Expected forward migrations

1. `202609230001_platform_role_management_permissions`
2. `202609230001_supplier_mapping_governance`
3. `202609250001_booking_concurrency_foundation`
4. `202609260001_authoritative_rate_amount_semantics`
5. `202609270001_supplier_admin_permissions`

Later schema objects were observed on an isolated child clone, but that clone's
Prisma migration history still ended before these five migrations. This is
schema behavior evidence only, **not successful Prisma migration-history
certification**. Use a fresh production child and the reviewed runner in
`docs/clone-certification-runner.md` to establish that evidence. The runner is
prepared but has not completed the persistent clone migration.

## Post-migration verification

Read-only verification must confirm:

- `SupplierRoomMapping` exists.
- `InventoryHold` exists.
- `InventoryHoldNight` exists.
- `DailyAvailability.held` exists and is non-negative.
- `DailyRate.amount_basis` exists.
- supplier Admin permissions exist.
- platform role/assignment permissions exist.
- RLS is enabled/forced on new tenant-owned tables.
- no failed, non-rolled-back migration rows exist.
- migration status is current.
- drift check exits cleanly.

Then run:
- tenant isolation tests;
- API E2E;
- Admin commercial operations tests;
- Dubai 7-day sellability certification;
- 100-hotel disposable test where appropriate;
- authenticated deployed smoke test.

## Abort conditions

Abort immediately if:
- Prisma reports a failed unresolved migration;
- any checksum mismatch appears;
- mapping-governance preflight fails;
- a migration attempts destructive/unexpected changes;
- the target database identity is uncertain;
- backup/recovery evidence is missing;
- post-migration status or drift fails.

Use an owner-approved forward-fix or verified restore process. Do not improvise with migration-history edits.

## Production booking

Remain disabled until this runbook passes, deployed smoke testing passes, and human release approval is recorded.
