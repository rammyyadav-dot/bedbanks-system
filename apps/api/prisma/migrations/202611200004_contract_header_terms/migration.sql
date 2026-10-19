-- ADR 0067 (F-20, F-15): contract header terms and the minimum-stay reading.
--
-- Commercial header, null meaning "not recorded" (never defaulted): rate type (NET or COMMISSIONABLE) with the commission in basis points,
-- payment terms in days, signature date and a reference to the signed document, and the allotment type (GUARANTEED, NON_GUARANTEED, FREE_SALE).
-- `min_stay_mode` says how a night's minimum stay applies: STAY_THROUGH (any night of the stay, the behaviour so far, hence the default) or
-- ARRIVAL (only the check-in night). These are reviewed terms: they are part of the contract fingerprint and change on an ACTIVE contract only
-- by an approved amendment.
-- Governance fields, editable at any time but EXPIRED: `owner_user_id` (a tenant member id) and `renewal_reminder_days` (default 60), which
-- flags a contract as due for renewal that many days before its last night.
--
-- Database rules mirror the API: a commission exists only on a commissionable contract and lies in 1..5000 bp; payment terms 0..365 days;
-- reminder 1..365 days.
--
-- Isolation: Contract keeps its forced RLS; writes stay on the privileged supply-authoring path. Tenant-index review: no new index (the columns
-- are read with the contract row).
--
-- Rollback (forward migration; reviewed before use):
--   ALTER TABLE "Contract" DROP CONSTRAINT "Contract_header_terms_check", DROP COLUMN "rate_type", DROP COLUMN "commission_bp",
--     DROP COLUMN "payment_terms_days", DROP COLUMN "signed_at", DROP COLUMN "signed_document_ref", DROP COLUMN "allotment_type",
--     DROP COLUMN "min_stay_mode", DROP COLUMN "owner_user_id", DROP COLUMN "renewal_reminder_days";
--   DROP TYPE "ContractRateType"; DROP TYPE "ContractAllotmentType"; DROP TYPE "MinStayMode";

CREATE TYPE "ContractRateType" AS ENUM ('NET', 'COMMISSIONABLE');
CREATE TYPE "ContractAllotmentType" AS ENUM ('GUARANTEED', 'NON_GUARANTEED', 'FREE_SALE');
CREATE TYPE "MinStayMode" AS ENUM ('STAY_THROUGH', 'ARRIVAL');

ALTER TABLE "Contract"
  ADD COLUMN "rate_type" "ContractRateType",
  ADD COLUMN "commission_bp" INTEGER,
  ADD COLUMN "payment_terms_days" INTEGER,
  ADD COLUMN "signed_at" DATE,
  ADD COLUMN "signed_document_ref" VARCHAR(200),
  ADD COLUMN "allotment_type" "ContractAllotmentType",
  ADD COLUMN "min_stay_mode" "MinStayMode" NOT NULL DEFAULT 'STAY_THROUGH',
  ADD COLUMN "owner_user_id" TEXT,
  ADD COLUMN "renewal_reminder_days" INTEGER NOT NULL DEFAULT 60,
  ADD CONSTRAINT "Contract_header_terms_check" CHECK (
    (("rate_type" = 'COMMISSIONABLE' AND "commission_bp" BETWEEN 1 AND 5000) OR ("rate_type" IS DISTINCT FROM 'COMMISSIONABLE' AND "commission_bp" IS NULL))
    AND ("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 365)
    AND "renewal_reminder_days" BETWEEN 1 AND 365
  );
