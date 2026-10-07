-- ADR 0039, Phase 6B: personal saved views of the booking list. A view is a PREFERENCE (a name, canonical booking-query filters, a sort, optionally columns),
-- never a security policy: it stores no tenant inside its JSON, no actor, no permission and nothing executable, and it is re-validated against the current grammar
-- and the current caller's access every time it is opened.
--
-- Isolation: forced row-level security on tenant_id, and the owner is tied to a MEMBERSHIP of the same tenant by a composite foreign key, so a view cannot name a user
-- outside its tenant and disappears with the membership. One default per person per tenant is a unique key over a nullable `default_slot` (NULLs are distinct, so
-- only a row holding 1 counts): no partial index, no trigger. The name is unique per person (case-insensitive through name_key).
-- Also data only: four permissions (booking.savedview.read / create / update.own / delete.own), granted to no role.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "BookingSavedView";
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" LIKE 'booking.savedview.%'); DELETE FROM "Permission" WHERE "key" LIKE 'booking.savedview.%';
CREATE TABLE "BookingSavedView" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "name" VARCHAR(60) NOT NULL,
  "name_key" VARCHAR(60) NOT NULL,
  "description" VARCHAR(200),
  "filter_version" INTEGER NOT NULL DEFAULT 1,
  "filters_json" JSONB NOT NULL,
  "sort_json" JSONB NOT NULL,
  "visible_columns_json" JSONB,
  "default_slot" SMALLINT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingSavedView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingSavedView_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingSavedView_owner_user_id_tenant_id_fkey" FOREIGN KEY ("owner_user_id", "tenant_id") REFERENCES "memberships"("user_id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingSavedView_shape_check" CHECK (
    char_length("name") BETWEEN 1 AND 60 AND "name_key" = lower("name") AND ("default_slot" IS NULL OR "default_slot" = 1) AND "filter_version" >= 1
    AND jsonb_typeof("filters_json") = 'object' AND jsonb_typeof("sort_json") = 'object' AND ("visible_columns_json" IS NULL OR jsonb_typeof("visible_columns_json") = 'array')
    AND NOT ("filters_json" ? 'tenantId' OR "filters_json" ? 'tenant_id' OR "filters_json" ? 'userId' OR "filters_json" ? 'permissions')
    AND pg_column_size("filters_json") <= 4096 AND pg_column_size("sort_json") <= 256 AND (pg_column_size("visible_columns_json") IS NULL OR pg_column_size("visible_columns_json") <= 512))
);
CREATE UNIQUE INDEX "BookingSavedView_tenant_id_owner_user_id_name_key_key" ON "BookingSavedView"("tenant_id", "owner_user_id", "name_key");
CREATE UNIQUE INDEX "BookingSavedView_tenant_id_owner_user_id_default_slot_key" ON "BookingSavedView"("tenant_id", "owner_user_id", "default_slot");
CREATE INDEX "BookingSavedView_tenant_id_owner_user_id_idx" ON "BookingSavedView"("tenant_id", "owner_user_id");

ALTER TABLE "BookingSavedView" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingSavedView" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingSavedView_tenant_isolation" ON "BookingSavedView"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_savedview_read', 'booking.savedview.read', 'See and open your own saved booking views'),
  ('perm_booking_savedview_create', 'booking.savedview.create', 'Save the current booking list as a personal view'),
  ('perm_booking_savedview_update_own', 'booking.savedview.update.own', 'Rename, update, set or clear the default of your own saved views'),
  ('perm_booking_savedview_delete_own', 'booking.savedview.delete.own', 'Delete your own saved views')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
