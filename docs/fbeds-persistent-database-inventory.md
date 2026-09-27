# fBeds Persistent Database Inventory — Owner Evidence

Status: **BLOCKED FOR PRODUCTION DEPLOYMENT — clone migration path validated; production migration not executed**

Release baseline: `71f5014767ca7aedeee68fe76f891de64d8d1b19`

This document operationalizes `docs/postgres-production-release-checklist.md`. It is an evidence register, not approval. Do not place connection strings, passwords, tokens, or raw secret values in Git.

## Verified provider inventory

| Environment | Provider project | Branch | Database | Compute endpoint | Persistence | Migration state | Owner | Decision |
|---|---|---|---|---|---|---|---|---|
| Production candidate | `square-grass-15016800` | `main` / `br-wandering-hill-au9gq1wv` | `neondb` | `ep-fancy-term-aucsh8rv` | Persistent | Through `202609220001_supply_permissions`; later repo migrations absent | Owner attestation required | BLOCKED |
| Non-production | `square-grass-15016800` | `fbeds-nonprod` / `br-sparkling-king-au5766p3` | `neondb` | `ep-blue-art-auo2cwp0` | Persistent/non-expiring candidate | Not fully certified | Owner attestation required | PARTIAL |
| Migration certification clone | `square-grass-15016800` | `cert-prod-migration-repair-20260927` / `br-green-voice-au1mklo0` | `neondb` | provider-created | Disposable certification branch | Exact missing DDL validated | N/A | PASS FOR CLONE ONLY |
| Staging | — | — | — | — | Not established | NOT VERIFIED | Owner attestation required | BLOCKED |

Provider metadata observed PostgreSQL 18 in AWS `us-east-1`. Both `main` and `fbeds-nonprod` were reported unprotected at audit time.

## Production migration reconciliation

Read-only `_prisma_migrations` inspection established that historical unsuccessful attempts for:
- `202609200001_platform_admin_access_foundation`
- `202609210001_platform_permission_catalog`

have non-null `rolled_back_at` values. They are formally rolled back historical attempts rather than unresolved in-progress rows.

The latest successful migration currently established on the Production candidate is:

`202609220001_supply_permissions`

The current repository additionally requires:

1. `202609230001_platform_role_management_permissions`
2. `202609230001_supplier_mapping_governance`
3. `202609250001_booking_concurrency_foundation`
4. `202609260001_authoritative_rate_amount_semantics`
5. `202609270001_supplier_admin_permissions`

## Physical schema gap confirmed

Production read-only catalog checks confirmed:
- `SupplierRoomMapping` absent.
- `InventoryHold` absent.
- `InventoryHoldNight` absent.
- `DailyAvailability.held` absent.
- `DailyRate.amount_basis` absent.
- `supply.suppliers.read` absent.
- `supply.suppliers.manage` absent.

Therefore current application `main` is not schema-compatible with the Production candidate.

## Clone migration certification

A child branch of Production was created solely for certification:

`br-green-voice-au1mklo0`

No Production mutation occurred.

The exact committed SQL effects of all five missing migrations were applied transactionally to the clone and completed successfully.

Verified clone postconditions:
- `SupplierRoomMapping` exists.
- `InventoryHold` exists.
- `InventoryHoldNight` exists.
- `DailyAvailability.held` exists.
- `DailyRate.amount_basis` exists.
- supplier Admin read/manage permissions exist.
- platform role/assignment permissions exist.
- required tenant RLS policies exist.
- supplier mapping governance preflight passed against copied Production data.
- schema comparison against Production showed the intended forward changes.

This validates schema compatibility of the missing migration sequence against a copy of Production data. It does **not** authorize raw SQL application to Production and it does not replace Prisma migration-history recording.

## Production repair rule

Production must be migrated only through the repository's normal Prisma migration path so `_prisma_migrations` remains authoritative.

Do not repair Production by:
- manually executing the migration SQL;
- manually inserting/updating `_prisma_migrations`;
- `prisma db push`;
- `prisma migrate reset`;
- guessed `prisma migrate resolve`.

The approved production operation, once owner-controlled release prerequisites are complete, is the exact committed migration chain via the governed Prisma migration runner.

## Runtime role / RLS evidence

The provider/audit connection executes as `neondb_owner`, which is non-superuser but has `BYPASSRLS` and owns `neondb`.

This does not prove the deployed HTTP API uses that role. Production release still requires evidence that the HTTP runtime uses a separate non-owner, non-superuser, non-`BYPASSRLS` role.

Tenant-scoped RLS policies were observed on the inspected operational tables.

## Owner-controlled evidence still required before Production migration

- Explicit database-owner approval for the migration window.
- Verified backup/recovery point and restore procedure.
- Actual HTTP runtime role identity and attributes.
- Preview/Development → `fbeds-nonprod` binding evidence.
- Monitoring/incident owner.
- Migration command execution through an approved Prisma runner.
- Post-migration `prisma migrate status`, drift verification and application smoke tests.

## Current decision

**Production migration/deployment remains BLOCKED.**

The schema repair has been validated safely on an isolated Production clone, but Production itself has not been changed.

Production booking remains disabled.
