-- ADR 0067 (F-09): combinable promotions, partial-stay windows and a room-only discount base.
--
-- `combinable` lets promotions the hotel allows to be combined stack (the buyer gets the better of the best single promotion and the stack).
-- `stay_window_mode` NIGHTS_IN_WINDOW discounts only the stay nights inside the window instead of requiring the whole stay inside it.
-- `discount_base` ROOM_ONLY leaves the extra-guest lines undiscounted. The defaults are today's behaviour, so every existing promotion is unchanged.
--
-- Isolation: RatePlanPromotion keeps its forced RLS; no data is rewritten. Tenant-index review: no new index.
--
-- Rollback (forward migration; reviewed before use):
--   ALTER TABLE "RatePlanPromotion" DROP CONSTRAINT "RatePlanPromotion_window_mode_check", DROP COLUMN "combinable", DROP COLUMN "stay_window_mode", DROP COLUMN "discount_base";
--   DROP TYPE "PromotionStayWindowMode"; DROP TYPE "PromotionDiscountBase";

CREATE TYPE "PromotionStayWindowMode" AS ENUM ('WHOLE_STAY', 'NIGHTS_IN_WINDOW');
CREATE TYPE "PromotionDiscountBase" AS ENUM ('ROOM_AND_GUESTS', 'ROOM_ONLY');

ALTER TABLE "RatePlanPromotion"
  ADD COLUMN "combinable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stay_window_mode" "PromotionStayWindowMode" NOT NULL DEFAULT 'WHOLE_STAY',
  ADD COLUMN "discount_base" "PromotionDiscountBase" NOT NULL DEFAULT 'ROOM_AND_GUESTS',
  ADD CONSTRAINT "RatePlanPromotion_window_mode_check" CHECK ("stay_window_mode" = 'WHOLE_STAY' OR "stay_from" IS NOT NULL OR "stay_to" IS NOT NULL);
