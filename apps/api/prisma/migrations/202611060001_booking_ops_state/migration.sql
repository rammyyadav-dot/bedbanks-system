-- ADR 0039, Phase 4: the durable operational state of the booking operations queue, and nothing else.
--
-- The queue itself is DERIVED (booking status, supplier answer, supplier jobs, the lifecycle log) by one ruleset in @bedbanks/contracts. Only facts that
-- are true because a person said so are stored here, one row per booking: who owns the case, when they acknowledged it, a manual priority floor, a manual
-- follow-up flag, and when that manual state was resolved. SLA state, "overdue by N minutes", reason and priority are never stored.
--
-- Tenant-composite key to Booking (cascades with it), tenant_id leading every index, FORCED row-level security (tenant_id = fbeds_current_tenant_id()).
-- `version` is the optimistic-concurrency counter every mutation compares and increments, so two people claiming one case get one winner and a conflict.
-- User references are SET NULL (a removed user leaves the audit trail, not a dangling owner). No existing table, row, policy or grant changes.
--
-- Rollback (forward migration; reviewed before use; only while no Phase 4 writer is running):
--   DROP TABLE "BookingOpsState"; DROP TYPE "BookingOpsPriority";
CREATE TYPE "BookingOpsPriority" AS ENUM ('NORMAL', 'HIGH', 'URGENT', 'CRITICAL');

CREATE TABLE "BookingOpsState" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "assignee_user_id" TEXT,
  "assigned_at" TIMESTAMP(3),
  "assigned_by_user_id" TEXT,
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by_user_id" TEXT,
  "manual_priority" "BookingOpsPriority",
  "escalated_at" TIMESTAMP(3),
  "escalated_by_user_id" TEXT,
  "escalation_reason" TEXT,
  "follow_up" BOOLEAN NOT NULL DEFAULT false,
  "follow_up_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "resolved_by_user_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingOpsState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingOpsState_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_escalated_by_user_id_fkey" FOREIGN KEY ("escalated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingOpsState_version_check" CHECK ("version" >= 1),
  CONSTRAINT "BookingOpsState_manual_priority_check" CHECK ("manual_priority" IS NULL OR "manual_priority" <> 'NORMAL'),
  CONSTRAINT "BookingOpsState_reason_check" CHECK ("escalation_reason" IS NULL OR length("escalation_reason") <= 500)
);
CREATE UNIQUE INDEX "BookingOpsState_tenant_id_booking_id_key" ON "BookingOpsState"("tenant_id", "booking_id");
CREATE INDEX "BookingOpsState_tenant_id_assignee_user_id_idx" ON "BookingOpsState"("tenant_id", "assignee_user_id");
CREATE INDEX "BookingOpsState_tenant_id_updated_at_idx" ON "BookingOpsState"("tenant_id", "updated_at");

ALTER TABLE "BookingOpsState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingOpsState" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingOpsState_tenant_isolation" ON "BookingOpsState"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Data only: the five operations permissions. Nothing is granted to any role; owner membership implies none of them.
-- Rollback: DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" LIKE 'booking.ops.%'); DELETE FROM "Permission" WHERE "key" LIKE 'booking.ops.%';
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_ops_view', 'booking.ops.view', 'See the booking operations queue, SLA and priority'),
  ('perm_booking_ops_assign', 'booking.ops.assign', 'Assign, unassign and acknowledge an operations case'),
  ('perm_booking_ops_escalate', 'booking.ops.escalate', 'Raise the priority of a case or flag a booking for follow-up'),
  ('perm_booking_ops_resolve', 'booking.ops.resolve', 'Record the supplier’s answer when it is uncertain'),
  ('perm_booking_ops_note', 'booking.ops.note', 'Add an internal operational note to a booking')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
