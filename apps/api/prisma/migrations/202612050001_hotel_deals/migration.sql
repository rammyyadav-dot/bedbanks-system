-- ADR 0089: hotel deals and promotions.
--
-- A deal is authored at hotel level for a set of the hotel's rate plans, approved by a second person (maker-checker, approval action `promotion.activate`),
-- and priced by the ONE stay evaluator: ACTIVE deals are read next to RatePlanPromotion rows and become PromotionRule objects (ADR 0058). Nothing is
-- written into RatePlanPromotion, which the strict runtime role may only read (ADR 0032). Money is integer minor units; a percentage is basis points.
--
-- Isolation: forced row-level security on tenant_id for both tables; every foreign key is composite on (tenant_id, id) so a deal can never point at another
-- tenant's hotel, plan or deal. Deals are never deleted (ARCHIVED instead), and there is no DELETE grant.
--
-- Database rules, so a bad deal cannot exist whatever the application does:
--   * a shape check per kind that mirrors `validateDeal` (one set of parameters per kind, ranges, windows, guards, audience lists);
--   * a state machine trigger: a deal starts as DRAFT, moves only along the allowed transitions, and its commercial terms cannot change once it leaves DRAFT
--     (a new version is made by returning it to DRAFT, which raises `version` and clears the fingerprint);
--   * the scope table can only change while the deal is a DRAFT, and a plan must belong to the deal's hotel;
--   * a deal that is PENDING_APPROVAL or later carries the SHA-256 fingerprint of the terms that were reviewed; an ACTIVE or SCHEDULED deal also carries its approval.
--
-- Tenant-index review: the evaluator loads ACTIVE deals by (tenant_id, rate_plan_id) -> index on HotelDealRatePlan, then by deal id; lists filter by
-- (tenant_id, hotel_id, status) and (tenant_id, status); code and idempotency key are unique per tenant.
--
-- Rollback (forward migration; reviewed before use; nothing else references these objects):
--   DROP TABLE "HotelDealRatePlan"; DROP TABLE "HotelDeal";
--   DROP FUNCTION "fbeds_hotel_deal_plan_guard"(); DROP FUNCTION "fbeds_hotel_deal_guard"();
--   DROP TYPE "HotelDealAmountScope"; DROP TYPE "HotelDealStatus"; DROP TYPE "HotelDealKind";

-- CreateEnum
CREATE TYPE "HotelDealKind" AS ENUM ('PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'STAY_X_PAY_Y', 'SUBSEQUENT_NIGHTS', 'EVERY_NTH_FREE', 'FIXED_OFF');
CREATE TYPE "HotelDealStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'EXPIRED', 'ARCHIVED');
CREATE TYPE "HotelDealAmountScope" AS ENUM ('PER_NIGHT', 'PER_STAY');

-- CreateTable
CREATE TABLE "HotelDeal" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "hotel_id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "code_key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "HotelDealKind" NOT NULL,
    "status" "HotelDealStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "percent_bp" INTEGER,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "amount_scope" "HotelDealAmountScope",
    "min_nights" INTEGER,
    "free_nights" INTEGER,
    "from_night" INTEGER,
    "min_lead_days" INTEGER,
    "book_from" DATE,
    "book_to" DATE,
    "stay_from" DATE,
    "stay_to" DATE,
    "weekdays" INTEGER,
    "stay_window_mode" "PromotionStayWindowMode" NOT NULL DEFAULT 'WHOLE_STAY',
    "discount_base" "PromotionDiscountBase" NOT NULL DEFAULT 'ROOM_AND_GUESTS',
    "combinable" BOOLEAN NOT NULL DEFAULT false,
    "stacking_group" VARCHAR(40),
    "incompatible_deal_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_markets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agency_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_discount_bp" INTEGER,
    "min_sell_floor_minor" BIGINT,
    "min_margin_bp" INTEGER,
    "funding_source" VARCHAR(16) NOT NULL DEFAULT 'SUPPLIER',
    "active_from" DATE,
    "active_to" DATE,
    "public_description" VARCHAR(500),
    "internal_notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "terms_fingerprint" CHAR(64),
    "approval_id" TEXT,
    "status_reason" VARCHAR(500),
    "status_changed_at" TIMESTAMP(3),
    "status_changed_by_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "activated_by_id" TEXT,
    "idempotency_key" VARCHAR(80) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HotelDeal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelDealRatePlan" (
    "tenant_id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    CONSTRAINT "HotelDealRatePlan_pkey" PRIMARY KEY ("deal_id","rate_plan_id")
);

-- CreateIndex
CREATE INDEX "HotelDeal_tenant_id_hotel_id_status_idx" ON "HotelDeal"("tenant_id", "hotel_id", "status");
CREATE INDEX "HotelDeal_tenant_id_status_idx" ON "HotelDeal"("tenant_id", "status");
CREATE UNIQUE INDEX "HotelDeal_tenant_id_id_key" ON "HotelDeal"("tenant_id", "id");
CREATE UNIQUE INDEX "HotelDeal_tenant_id_code_key_key" ON "HotelDeal"("tenant_id", "code_key");
CREATE UNIQUE INDEX "HotelDeal_tenant_id_idempotency_key_key" ON "HotelDeal"("tenant_id", "idempotency_key");
CREATE INDEX "HotelDealRatePlan_tenant_id_rate_plan_id_idx" ON "HotelDealRatePlan"("tenant_id", "rate_plan_id");

-- AddForeignKey
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelDealRatePlan" ADD CONSTRAINT "HotelDealRatePlan_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelDealRatePlan" ADD CONSTRAINT "HotelDealRatePlan_tenant_id_deal_id_fkey" FOREIGN KEY ("tenant_id", "deal_id") REFERENCES "HotelDeal"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelDealRatePlan" ADD CONSTRAINT "HotelDealRatePlan_tenant_id_rate_plan_id_fkey" FOREIGN KEY ("tenant_id", "rate_plan_id") REFERENCES "RatePlan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: general rules.
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_shape_check" CHECK (
  "code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$' AND "code_key" = lower("code")
  AND char_length(btrim("name")) BETWEEN 1 AND 80
  AND "priority" BETWEEN 0 AND 100
  AND "funding_source" = 'SUPPLIER'
  AND "version" >= 1
  AND "incompatible_deal_ids" IS NOT NULL AND "channels" IS NOT NULL AND "source_markets" IS NOT NULL AND "agency_ids" IS NOT NULL
  AND cardinality("incompatible_deal_ids") <= 20 AND cardinality("agency_ids") <= 100 AND cardinality("source_markets") <= 250 AND cardinality("channels") <= 2
  AND "channels" <@ ARRAY['PORTAL', 'API']::text[]
  AND array_to_string("source_markets", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'
  AND ("weekdays" IS NULL OR "weekdays" BETWEEN 1 AND 127)
  AND ("book_from" IS NULL OR "book_to" IS NULL OR "book_to" >= "book_from")
  AND ("stay_from" IS NULL OR "stay_to" IS NULL OR "stay_to" >= "stay_from")
  AND ("active_from" IS NULL OR "active_to" IS NULL OR "active_to" >= "active_from")
  AND ("stay_window_mode" = 'WHOLE_STAY' OR "stay_from" IS NOT NULL OR "stay_to" IS NOT NULL)
  AND ("max_discount_bp" IS NULL OR "max_discount_bp" BETWEEN 1 AND 9000)
  AND ("min_sell_floor_minor" IS NULL OR "min_sell_floor_minor" BETWEEN 1 AND 1000000000)
  AND ("min_margin_bp" IS NULL OR "min_margin_bp" BETWEEN 1 AND 9000)
  AND ("stacking_group" IS NULL OR "stacking_group" ~ '^[A-Za-z0-9_-]{1,40}$')
  AND ("public_description" IS NULL OR char_length("public_description") <= 500)
);

-- Shape: one set of parameters per kind.
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_kind_check" CHECK (
  (
    "kind" IN ('PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'SUBSEQUENT_NIGHTS')
    AND "percent_bp" BETWEEN 1 AND 9000 AND "amount_minor" IS NULL AND "currency" IS NULL AND "amount_scope" IS NULL AND "free_nights" IS NULL
    AND ("min_nights" IS NULL OR "min_nights" BETWEEN 1 AND 365)
  ) OR (
    "kind" = 'STAY_X_PAY_Y'
    AND "percent_bp" IS NULL AND "amount_minor" IS NULL AND "currency" IS NULL AND "amount_scope" IS NULL
    AND "min_nights" BETWEEN 2 AND 365 AND "free_nights" BETWEEN 1 AND 364 AND "free_nights" < "min_nights"
  ) OR (
    "kind" = 'EVERY_NTH_FREE'
    AND "percent_bp" IS NULL AND "amount_minor" IS NULL AND "currency" IS NULL AND "amount_scope" IS NULL AND "free_nights" IS NULL
    AND "min_nights" BETWEEN 2 AND 365
  ) OR (
    "kind" = 'FIXED_OFF'
    AND "percent_bp" IS NULL AND "free_nights" IS NULL
    AND "amount_minor" BETWEEN 1 AND 1000000000 AND "currency" ~ '^[A-Z]{3}$' AND "amount_scope" IS NOT NULL
    AND ("min_nights" IS NULL OR "min_nights" BETWEEN 1 AND 365)
  )
);
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_kind_fields_check" CHECK (
  ("kind" = 'EARLY_BIRD') = ("min_lead_days" IS NOT NULL) AND ("min_lead_days" IS NULL OR "min_lead_days" BETWEEN 1 AND 730)
  AND ("kind" = 'SUBSEQUENT_NIGHTS') = ("from_night" IS NOT NULL) AND ("from_night" IS NULL OR "from_night" BETWEEN 2 AND 365)
  AND ("kind" <> 'FLASH_SALE' OR ("book_from" IS NOT NULL AND "book_to" IS NOT NULL))
);

-- Shape: lifecycle evidence.
ALTER TABLE "HotelDeal" ADD CONSTRAINT "HotelDeal_lifecycle_check" CHECK (
  ("status" NOT IN ('PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'EXPIRED') OR "terms_fingerprint" IS NOT NULL)
  AND ("status" NOT IN ('SCHEDULED', 'ACTIVE') OR ("approval_id" IS NOT NULL AND "activated_at" IS NOT NULL AND "activated_by_id" IS NOT NULL))
  AND ("status" <> 'SCHEDULED' OR "active_from" IS NOT NULL)
  AND ("status" NOT IN ('REJECTED', 'PAUSED', 'SUSPENDED') OR char_length(btrim("status_reason")) >= 3)
  AND ("terms_fingerprint" IS NULL OR "terms_fingerprint" ~ '^[0-9a-f]{64}$')
);

-- State machine and immutability of the commercial terms.
CREATE FUNCTION "fbeds_hotel_deal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lifecycle text[] := ARRAY['status', 'status_reason', 'status_changed_at', 'status_changed_by_id', 'activated_at', 'activated_by_id', 'approval_id', 'terms_fingerprint', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'HOTEL_DEAL_MUST_START_AS_DRAFT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id" OR NEW."hotel_id" <> OLD."hotel_id" OR NEW."created_by_id" <> OLD."created_by_id"
     OR NEW."idempotency_key" <> OLD."idempotency_key" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'HOTEL_DEAL_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('DRAFT', 'PENDING_APPROVAL'), ('DRAFT', 'ARCHIVED'),
        ('PENDING_APPROVAL', 'APPROVED'), ('PENDING_APPROVAL', 'REJECTED'), ('PENDING_APPROVAL', 'DRAFT'),
        ('APPROVED', 'SCHEDULED'), ('APPROVED', 'ACTIVE'), ('APPROVED', 'DRAFT'),
        ('REJECTED', 'DRAFT'), ('REJECTED', 'ARCHIVED'),
        ('SCHEDULED', 'ACTIVE'), ('SCHEDULED', 'PAUSED'), ('SCHEDULED', 'SUSPENDED'), ('SCHEDULED', 'EXPIRED'),
        ('ACTIVE', 'PAUSED'), ('ACTIVE', 'SUSPENDED'), ('ACTIVE', 'EXPIRED'),
        ('PAUSED', 'ACTIVE'), ('PAUSED', 'SCHEDULED'), ('PAUSED', 'SUSPENDED'), ('PAUSED', 'EXPIRED'), ('PAUSED', 'ARCHIVED'),
        ('SUSPENDED', 'DRAFT'), ('SUSPENDED', 'ARCHIVED'),
        ('EXPIRED', 'ARCHIVED')
      ) AS allowed(from_status, to_status)
      WHERE allowed.from_status = OLD."status"::text AND allowed.to_status = NEW."status"::text
    ) THEN
      RAISE EXCEPTION 'HOTEL_DEAL_TRANSITION_NOT_ALLOWED: % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(OLD) - lifecycle) IS DISTINCT FROM (to_jsonb(NEW) - lifecycle) THEN
    RAISE EXCEPTION 'HOTEL_DEAL_TERMS_LOCKED' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    IF NEW."version" <> OLD."version" + 1 OR NEW."terms_fingerprint" IS NOT NULL OR NEW."approval_id" IS NOT NULL OR NEW."activated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'HOTEL_DEAL_NEW_VERSION_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'HOTEL_DEAL_VERSION_BACKWARDS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HotelDeal_guard" BEFORE INSERT OR UPDATE ON "HotelDeal" FOR EACH ROW EXECUTE FUNCTION "fbeds_hotel_deal_guard"();

-- The scope changes only while the deal is a DRAFT, and a plan must belong to the deal's hotel.
CREATE FUNCTION "fbeds_hotel_deal_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  deal_status "HotelDealStatus";
  deal_hotel text;
  plan_hotel text;
BEGIN
  SELECT d."status", d."hotel_id" INTO deal_status, deal_hotel FROM "HotelDeal" d WHERE d."id" = COALESCE(NEW."deal_id", OLD."deal_id") AND d."tenant_id" = COALESCE(NEW."tenant_id", OLD."tenant_id");
  IF deal_status IS NULL OR deal_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'HOTEL_DEAL_SCOPE_LOCKED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT rt."hotel_id" INTO plan_hotel FROM "RatePlan" rp JOIN "RoomType" rt ON rt."id" = rp."room_type_id" WHERE rp."id" = NEW."rate_plan_id" AND rp."tenant_id" = NEW."tenant_id";
    IF plan_hotel IS NULL OR plan_hotel <> deal_hotel THEN
      RAISE EXCEPTION 'HOTEL_DEAL_PLAN_OTHER_HOTEL' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "HotelDealRatePlan_guard" BEFORE INSERT OR DELETE ON "HotelDealRatePlan" FOR EACH ROW EXECUTE FUNCTION "fbeds_hotel_deal_plan_guard"();

-- Isolation.
ALTER TABLE "HotelDeal" ENABLE ROW LEVEL SECURITY; ALTER TABLE "HotelDeal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "HotelDeal_tenant_isolation" ON "HotelDeal" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "HotelDealRatePlan" ENABLE ROW LEVEL SECURITY; ALTER TABLE "HotelDealRatePlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "HotelDealRatePlan_tenant_isolation" ON "HotelDealRatePlan" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
