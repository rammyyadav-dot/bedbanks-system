-- ADR 0057 slice S2b: named cancellation rule sets per contract, attachable to a rate plan.
-- Additive and nullable. Existing rules keep policy_set NULL (the contract default) and existing plans keep cancellation_policy_set NULL,
-- so every plan resolves exactly the rules it resolves today.
-- Tenant-index review: CancellationPolicy has no tenant column; its forced RLS policy joins Contract. Reads are by contract_id, covered by the new (contract_id, policy_set) index.
-- Rollback: DROP INDEX "CancellationPolicy_contract_id_policy_set_idx"; ALTER TABLE "CancellationPolicy" DROP COLUMN "policy_set"; ALTER TABLE "RatePlan" DROP COLUMN "cancellation_policy_set";
-- RLS policies, grants and the rate-plan-ops role are unchanged.

ALTER TABLE "CancellationPolicy" ADD COLUMN "policy_set" VARCHAR(80);
ALTER TABLE "RatePlan" ADD COLUMN "cancellation_policy_set" VARCHAR(80);
CREATE INDEX "CancellationPolicy_contract_id_policy_set_idx" ON "CancellationPolicy"("contract_id", "policy_set");
