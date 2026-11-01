-- ADR 0076 (revenue report): BookingFinancePosting records what each POSTED event charged the agency (sales_minor, the DEBIT legs) and refunded it (refunds_minor, the REFUND legs),
-- so the revenue report is a plain aggregation of what the consumer posted. Both are integer minor units in the posting's currency, never negative, and zero unless the posting is POSTED.
-- The consumer is off by default and has posted nothing in any deployment, so existing rows (none) need no backfill; the defaults are zero.
-- No new table, grant or index: the existing (tenant_id, status, updated_at) index and the tenant-led unique key serve the report. The consumer role's UPDATE grant is extended to the two
-- columns by its provisioning (apps/api/src/database/finance-posting-role.ts), because a posting under review is later closed with its amounts.
--
-- Rollback (forward migration; reviewed before use; only while the worker is stopped; the report then cannot be produced):
--   ALTER TABLE "BookingFinancePosting" DROP CONSTRAINT "BookingFinancePosting_amounts";
--   ALTER TABLE "BookingFinancePosting" DROP COLUMN "refunds_minor", DROP COLUMN "sales_minor";

-- AlterTable
ALTER TABLE "BookingFinancePosting" ADD COLUMN     "refunds_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "sales_minor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "BookingFinancePosting"
  ADD CONSTRAINT "BookingFinancePosting_amounts" CHECK ("sales_minor" >= 0 AND "refunds_minor" >= 0 AND ("status" = 'POSTED' OR ("sales_minor" = 0 AND "refunds_minor" = 0)));
