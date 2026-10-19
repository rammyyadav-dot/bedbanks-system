-- ADR 0067 (supplements): board and compulsory supplements on a contract.
--
-- A BOARD supplement prices the plans sold on its board (for example half board on a bed-and-breakfast rate); a COMPULSORY supplement is a
-- mandatory charge such as a gala dinner. Each is per adult, per child, per person or per room, per night or once per stay, optionally limited to
-- a window of stay nights and to one plan of the contract. The evaluator adds it after the promotion and before the markup, in the plan's basis.
-- Supplements are reviewed contract terms: part of the fingerprint, editable only while terms are, amended on an ACTIVE contract.
--
-- Isolation: forced RLS through the owning contract, as for ChildPolicy. Tenant-index review: rows are read by contract (contract_id index);
-- tenant isolation is the contract's.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "ContractSupplement"; DROP TYPE "SupplementKind"; DROP TYPE "SupplementBasis"; DROP TYPE "SupplementFrequency";

CREATE TYPE "SupplementKind" AS ENUM ('BOARD', 'COMPULSORY');
CREATE TYPE "SupplementBasis" AS ENUM ('PER_ADULT', 'PER_CHILD', 'PER_PERSON', 'PER_ROOM');
CREATE TYPE "SupplementFrequency" AS ENUM ('PER_NIGHT', 'PER_STAY');

CREATE TABLE "ContractSupplement" (
  "id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "kind" "SupplementKind" NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "board_basis_id" TEXT,
  "rate_plan_id" TEXT,
  "basis" "SupplementBasis" NOT NULL,
  "frequency" "SupplementFrequency" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "stay_from" DATE,
  "stay_to" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractSupplement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContractSupplement_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContractSupplement_board_basis_id_fkey" FOREIGN KEY ("board_basis_id") REFERENCES "BoardBasis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ContractSupplement_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContractSupplement_terms_check" CHECK (
    "amount_minor" > 0 AND "currency" ~ '^[A-Z]{3}$' AND char_length(btrim("name")) >= 1
    AND (("kind" = 'BOARD') = ("board_basis_id" IS NOT NULL))
    AND ("stay_from" IS NULL OR "stay_to" IS NULL OR "stay_to" >= "stay_from")
  )
);
CREATE INDEX "ContractSupplement_contract_id_idx" ON "ContractSupplement"("contract_id");

ALTER TABLE "ContractSupplement" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ContractSupplement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ContractSupplement_tenant_isolation" ON "ContractSupplement"
  USING (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "ContractSupplement"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "ContractSupplement"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"()));
