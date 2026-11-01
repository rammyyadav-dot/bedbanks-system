-- ADR 0067 (F-01): contract maker-checker and versioning.
--
-- A contract becomes ACTIVE only through an approved, single-use `contract.approve` request, and an ACTIVE contract changes only through an
-- approved amendment. Each approved change appends one immutable snapshot here: the terms the checker reviewed, the SHA-256 fingerprint the
-- approval was bound to, and who requested, approved and applied it. `Contract.version` is the snapshot's version.
--
-- Immutability: a trigger refuses UPDATE and DELETE for every role, so history cannot be rewritten by the application or an operator session.
-- The contract foreign key is RESTRICT, so a contract with history cannot be deleted either.
--
-- Isolation: forced row-level security on tenant_id, like Contract. Writes are the privileged supply-authoring path (ADR 0032); the runtime
-- role reads it.
--
-- Tenant-index review: reads are by (tenant_id, contract_id), covered by the new index; the unique key (contract_id, version) orders history.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TRIGGER "ContractVersion_immutable" ON "ContractVersion"; DROP FUNCTION "fbeds_contract_version_immutable"();
--   DROP TABLE "ContractVersion"; DROP TYPE "ContractVersionKind";
--   Contracts keep their status and version; only the history rows are lost.

CREATE TYPE "ContractVersionKind" AS ENUM ('ACTIVATION', 'AMENDMENT');

CREATE TABLE "ContractVersion" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" "ContractVersionKind" NOT NULL,
  "terms" JSONB NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "approval_id" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT NOT NULL,
  "applied_by_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContractVersion_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ContractVersion_shape_check" CHECK ("version" >= 1 AND "fingerprint" ~ '^[0-9a-f]{64}$' AND "requested_by_id" <> "approved_by_id" AND char_length("reason") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "ContractVersion_contract_id_version_key" ON "ContractVersion"("contract_id", "version");
CREATE INDEX "ContractVersion_tenant_id_contract_id_idx" ON "ContractVersion"("tenant_id", "contract_id");

CREATE FUNCTION "fbeds_contract_version_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ContractVersion rows are immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "ContractVersion_immutable" BEFORE UPDATE OR DELETE ON "ContractVersion" FOR EACH ROW EXECUTE FUNCTION "fbeds_contract_version_immutable"();

ALTER TABLE "ContractVersion" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ContractVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ContractVersion_tenant_isolation" ON "ContractVersion"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
