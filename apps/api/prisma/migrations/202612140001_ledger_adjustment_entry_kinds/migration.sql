-- ADR 0100, step 1 of 2: the ledger gets two entry kinds, ADJUSTMENT (a reasoned correction, either direction) and REVERSAL (a received payment taken back, always negative).
--
-- A new enum value cannot be used in the transaction that adds it, so this migration only adds the values. The table, the sign rule and the permissions that use them are in
-- 202612140002_ledger_adjustments. Nothing writes either kind until that migration is applied and LEDGER_ADJUSTMENTS_ENABLED=true.
--
-- Until step 2 the existing "LedgerEntry_sign_by_type" CHECK rejects both kinds (neither is in its list), so applying this alone cannot let an unguarded entry in.
--
-- Rollback: PostgreSQL cannot drop an enum value. The values are harmless while unused; do not remove them. Disable the feature instead (unset LEDGER_ADJUSTMENTS_ENABLED).
-- Runtime roles: no GRANT or REVOKE. Tenant-index review: none, no table is touched.

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REVERSAL';
