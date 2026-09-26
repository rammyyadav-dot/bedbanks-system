-- Forward-only commercial semantics foundation.
-- Existing rate rows remain NULL and fail closed until a commercial owner
-- explicitly classifies them; this migration never guesses NET versus SELL.
CREATE TYPE "RateAmountBasis" AS ENUM ('NET', 'SELL');

ALTER TABLE "DailyRate"
  ADD COLUMN "amount_basis" "RateAmountBasis";

CREATE INDEX "DailyRate_tenant_id_amount_basis_stay_date_idx"
  ON "DailyRate"("tenant_id", "amount_basis", "stay_date");
