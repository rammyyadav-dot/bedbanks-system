-- ADR 0039, Phase 2: the lifecycle log records which named action made each change and the idempotency key of the request that made it.
--
-- action               the named lifecycle action (e.g. confirmOnRequest); NULL on rows written before Phase 2.
-- idempotency_key      the request's Idempotency-Key (8-128 chars); NULL for system rows and backfilled rows.
-- request_fingerprint  SHA-256 hex of the canonical request, so a replay with a different body under the same key is a conflict, not a silent success.
-- A unique index on (tenant_id, booking_id, idempotency_key) makes a replay a lookup. NULLs are distinct in PostgreSQL, so unkeyed rows never collide.
-- Additive and nullable: the immutability trigger and RLS policy from 202611020001 apply unchanged. tenant_id leads the new index.
--
-- Rollback: DROP INDEX "BookingEvent_tenant_id_booking_id_idempotency_key_key"; ALTER TABLE "BookingEvent" DROP COLUMN "action", DROP COLUMN "idempotency_key", DROP COLUMN "request_fingerprint";
-- (safe only while no Phase 2 writer is running).
ALTER TABLE "BookingEvent"
  ADD COLUMN "action" TEXT,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_fingerprint" TEXT,
  ADD CONSTRAINT "BookingEvent_idempotency_key_check" CHECK ("idempotency_key" IS NULL OR (length("idempotency_key") BETWEEN 8 AND 128 AND "request_fingerprint" ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX "BookingEvent_tenant_id_booking_id_idempotency_key_key" ON "BookingEvent"("tenant_id", "booking_id", "idempotency_key");
