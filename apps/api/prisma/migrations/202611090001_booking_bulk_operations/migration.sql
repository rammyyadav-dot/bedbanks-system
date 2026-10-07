-- ADR 0039, Phase 6C: bulk actions on bookings. ORCHESTRATION records only: one operation per request and one item per selected booking. The business effect of
-- every item is made by the existing single-booking service (which keeps its own permission, row lock, version check, idempotency and audit); nothing here updates a booking.
--
-- Isolation: forced row-level security on tenant_id; the requester is tied to a MEMBERSHIP of the same tenant by a composite foreign key; items are tied to their operation
-- by a composite (tenant_id, operation_id) key, so an item can never belong to another tenant's operation. `booking_id` on an item is deliberately NOT a foreign key: an
-- id that does not exist (or belongs to another tenant) must still be recorded as a NOT_FOUND result, and nothing about it is copied from any booking.
-- Idempotency is a database constraint: unique (tenant, requester, action, idempotency key); the request fingerprint detects the same key used for a different request.
-- No guest data, no exception text and no booking snapshot is stored: only ids, counts and stable machine-readable codes.
-- Also data only: three permissions (booking.bulk.assign / acknowledge / read), granted to no role.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "BookingBulkOperationItem"; DROP TABLE "BookingBulkOperation";
--   DROP TYPE "BookingBulkItemStatus"; DROP TYPE "BookingBulkSelectionMode"; DROP TYPE "BookingBulkStatus"; DROP TYPE "BookingBulkActionType";
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" LIKE 'booking.bulk.%'); DELETE FROM "Permission" WHERE "key" LIKE 'booking.bulk.%';
CREATE TYPE "BookingBulkActionType" AS ENUM ('ASSIGN_OWNER', 'ACKNOWLEDGE');
CREATE TYPE "BookingBulkStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARTIAL', 'SUCCEEDED', 'FAILED');
CREATE TYPE "BookingBulkSelectionMode" AS ENUM ('EXPLICIT_IDS');
CREATE TYPE "BookingBulkItemStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "BookingBulkOperation" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "requested_by_user_id" TEXT NOT NULL,
  "action_type" "BookingBulkActionType" NOT NULL,
  "status" "BookingBulkStatus" NOT NULL DEFAULT 'PENDING',
  "selection_mode" "BookingBulkSelectionMode" NOT NULL DEFAULT 'EXPLICIT_IDS',
  "request_version" INTEGER NOT NULL DEFAULT 1,
  "action_payload" JSONB NOT NULL DEFAULT '{}',
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "requested_count" INTEGER NOT NULL,
  "processed_count" INTEGER NOT NULL DEFAULT 0,
  "succeeded_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingBulkOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingBulkOperation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingBulkOperation_requested_by_user_id_tenant_id_fkey" FOREIGN KEY ("requested_by_user_id", "tenant_id") REFERENCES "memberships"("user_id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingBulkOperation_counts_check" CHECK (
    "requested_count" BETWEEN 1 AND 100 AND "processed_count" >= 0 AND "succeeded_count" >= 0 AND "failed_count" >= 0
    AND "succeeded_count" + "failed_count" = "processed_count" AND "processed_count" <= "requested_count"
    AND jsonb_typeof("action_payload") = 'object' AND pg_column_size("action_payload") <= 512
    AND ("status" NOT IN ('SUCCEEDED', 'PARTIAL', 'FAILED') OR "processed_count" = "requested_count"))
);
CREATE UNIQUE INDEX "BookingBulkOperation_tenant_id_id_key" ON "BookingBulkOperation"("tenant_id", "id");
CREATE UNIQUE INDEX "BookingBulkOperation_idempotency_key" ON "BookingBulkOperation"("tenant_id", "requested_by_user_id", "action_type", "idempotency_key");
CREATE INDEX "BookingBulkOperation_requester_created_idx" ON "BookingBulkOperation"("tenant_id", "requested_by_user_id", "created_at");

CREATE TABLE "BookingBulkOperationItem" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "booking_id" VARCHAR(80) NOT NULL,
  "position" INTEGER NOT NULL,
  "status" "BookingBulkItemStatus" NOT NULL DEFAULT 'PENDING',
  "error_code" VARCHAR(40),
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "BookingBulkOperationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingBulkOperationItem_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingBulkOperationItem_tenant_id_operation_id_fkey" FOREIGN KEY ("tenant_id", "operation_id") REFERENCES "BookingBulkOperation"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingBulkOperationItem_state_check" CHECK ("position" >= 0 AND (("status" = 'FAILED') = ("error_code" IS NOT NULL)) AND (("status" = 'PENDING') = ("processed_at" IS NULL)) AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z_]{3,40}$'))
);
CREATE UNIQUE INDEX "BookingBulkOperationItem_operation_id_booking_id_key" ON "BookingBulkOperationItem"("operation_id", "booking_id");
CREATE INDEX "BookingBulkOperationItem_tenant_id_operation_id_idx" ON "BookingBulkOperationItem"("tenant_id", "operation_id");

ALTER TABLE "BookingBulkOperation" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingBulkOperation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingBulkOperation_tenant_isolation" ON "BookingBulkOperation" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "BookingBulkOperationItem" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingBulkOperationItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingBulkOperationItem_tenant_isolation" ON "BookingBulkOperationItem" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_bulk_assign', 'booking.bulk.assign', 'Run the bulk assign-or-change-owner action on selected bookings (each booking still needs booking.ops.assign)'),
  ('perm_booking_bulk_acknowledge', 'booking.bulk.acknowledge', 'Run the bulk acknowledge action on selected bookings (each booking still needs booking.ops.assign)'),
  ('perm_booking_bulk_read', 'booking.bulk.read', 'See the result of your own bulk actions')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
