-- ADR 0067: automated compliance reporting hooks.
--
-- ComplianceRecord              an immutable copy of every compliance-relevant audit event (RBAC changes, privileged access, access denials, tenant governance,
--                               data exports, financial controls, booking jurisdiction). Appended by the AFTER INSERT trigger "AuditEvent_compliance_capture"
--                               in the SAME transaction as the audit event: a rolled-back mutation leaves no record, a committed one always has it, and no
--                               application code path can skip it. One record per audit event (id = the audit event id). payload_sha256 is the SHA-256 of the
--                               audit payload's jsonb text, so an exported record can be checked against the audit log. For booking events the trigger adds the
--                               buyer (agency) and destination (hotel) ISO-3166 countries and cross_border (NULL when either is unknown). No guest data.
-- ComplianceExportBatch         a sealed, hash-chained batch per scope (a tenant id, or 'platform' for tenantless platform events). batch_sha256 covers the
--                               previous batch's hash, so the chain breaks if any batch is altered, removed or reordered. Written only by the dedicated
--                               compliance export role (owner-run provisioning, apps/api/src/compliance/compliance-role.ts), which then stores the batch in
--                               WORM object storage and may flip storage_status SEALED -> STORED once; every other column is immutable (trigger).
-- ComplianceExportBatchRecord   which record is in which batch, at which position. record_id is unique: a record is exported exactly once.
-- fbeds_compliance_category()   the classifier, GENERATED from apps/api/src/compliance/compliance-classification.ts (a spec compares it).
-- fbeds_compliance_due_scopes() SECURITY DEFINER, returns scope keys only (tenant ids / 'platform') that have unexported records or an unstored batch.
-- fbeds_compliance_known_scopes() SECURITY DEFINER, every scope key with a record or a batch (for the verifier).
--                               EXECUTE on both is granted to the compliance group by provisioning, not here.
--
-- Row-level security is ENABLED and FORCED on all three tables. Tenant rows are visible only in their tenant (fbeds_current_tenant_id()); tenantless
-- platform rows only in a transaction that set app.compliance_scope = 'platform'. Records are inserted only while the trigger has set the transaction-local
-- app.compliance_capture flag. No privilege is granted to any role by this migration: the API runtime role, booking and hold-expiry roles get nothing; the
-- capture trigger runs as the owner (SECURITY DEFINER), so their existing audit inserts keep working unchanged.
-- No foreign key to tenants: compliance evidence must outlive a tenant (retention), and a tenant deletion must not be blocked by it.
-- Tenant-index review: tenant_id leads every new index; scope_key equals tenant_id for tenant rows (CHECK).
--
-- Rollback (forward migration; reviewed before use; only while the exporter is stopped; archived objects stay in WORM storage):
--   DROP TRIGGER "AuditEvent_compliance_capture" ON "AuditEvent";
--   DROP FUNCTION "fbeds_compliance_capture"(); DROP FUNCTION "fbeds_compliance_due_scopes"(); DROP FUNCTION "fbeds_compliance_known_scopes"(); DROP FUNCTION "fbeds_compliance_category"(TEXT);
--   DROP TABLE "ComplianceExportBatchRecord"; DROP TABLE "ComplianceExportBatch"; DROP TABLE "ComplianceRecord";
--   DROP FUNCTION "fbeds_compliance_immutable"(); DROP FUNCTION "fbeds_compliance_batch_guard"();
--   DROP FUNCTION "fbeds_compliance_scope_visible"(TEXT); DROP FUNCTION "fbeds_compliance_capture_active"();
--   DROP TYPE "ComplianceStorageStatus"; DROP TYPE "ComplianceCategory";
CREATE TYPE "ComplianceCategory" AS ENUM ('RBAC_CHANGE', 'PRIVILEGED_ACCESS', 'ACCESS_DENIAL', 'TENANT_GOVERNANCE', 'DATA_EXPORT', 'FINANCIAL_CONTROL', 'BOOKING_JURISDICTION');
CREATE TYPE "ComplianceStorageStatus" AS ENUM ('SEALED', 'STORED');

CREATE TABLE "ComplianceRecord" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "category" "ComplianceCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "origin_country" CHAR(2),
    "destination_country" CHAR(2),
    "cross_border" BOOLEAN,
    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComplianceRecord_payload_sha256_format" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ComplianceRecord_jurisdiction_check" CHECK ("cross_border" IS NULL OR ("origin_country" IS NOT NULL AND "destination_country" IS NOT NULL AND "cross_border" = ("origin_country" <> "destination_country")))
);
CREATE INDEX "ComplianceRecord_tenant_id_occurred_at_id_idx" ON "ComplianceRecord"("tenant_id", "occurred_at", "id");
CREATE INDEX "ComplianceRecord_tenant_id_category_occurred_at_idx" ON "ComplianceRecord"("tenant_id", "category", "occurred_at");

CREATE TABLE "ComplianceExportBatch" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "scope_key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "format_version" INTEGER NOT NULL DEFAULT 1,
    "record_count" INTEGER NOT NULL,
    "first_occurred_at" TIMESTAMP(3) NOT NULL,
    "last_occurred_at" TIMESTAMP(3) NOT NULL,
    "body_sha256" CHAR(64) NOT NULL,
    "previous_sha256" CHAR(64) NOT NULL,
    "batch_sha256" CHAR(64) NOT NULL,
    "object_key" TEXT NOT NULL,
    "retain_until" TIMESTAMP(3) NOT NULL,
    "storage_status" "ComplianceStorageStatus" NOT NULL DEFAULT 'SEALED',
    "object_version_id" TEXT,
    "sealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stored_at" TIMESTAMP(3),
    CONSTRAINT "ComplianceExportBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComplianceExportBatch_scope_check" CHECK (("tenant_id" IS NULL AND "scope_key" = 'platform') OR ("tenant_id" IS NOT NULL AND "scope_key" = "tenant_id")),
    CONSTRAINT "ComplianceExportBatch_sequence_check" CHECK ("sequence" >= 1 AND "format_version" >= 1 AND "record_count" BETWEEN 1 AND 5000 AND "first_occurred_at" <= "last_occurred_at"),
    CONSTRAINT "ComplianceExportBatch_hash_format" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$' AND "previous_sha256" ~ '^[0-9a-f]{64}$' AND "batch_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ComplianceExportBatch_genesis_check" CHECK (("sequence" = 1) = ("previous_sha256" = repeat('0', 64))),
    CONSTRAINT "ComplianceExportBatch_stored_check" CHECK (("storage_status" = 'STORED') = ("stored_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "ComplianceExportBatch_scope_key_sequence_key" ON "ComplianceExportBatch"("scope_key", "sequence");
CREATE UNIQUE INDEX "ComplianceExportBatch_object_key_key" ON "ComplianceExportBatch"("object_key");
CREATE INDEX "ComplianceExportBatch_tenant_id_storage_status_idx" ON "ComplianceExportBatch"("tenant_id", "storage_status");

CREATE TABLE "ComplianceExportBatchRecord" (
    "batch_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "tenant_id" TEXT,
    "record_id" TEXT NOT NULL,
    CONSTRAINT "ComplianceExportBatchRecord_pkey" PRIMARY KEY ("batch_id", "position"),
    CONSTRAINT "ComplianceExportBatchRecord_position_check" CHECK ("position" >= 1)
);
CREATE UNIQUE INDEX "ComplianceExportBatchRecord_record_id_key" ON "ComplianceExportBatchRecord"("record_id");
CREATE INDEX "ComplianceExportBatchRecord_tenant_id_batch_id_idx" ON "ComplianceExportBatchRecord"("tenant_id", "batch_id");
ALTER TABLE "ComplianceExportBatchRecord" ADD CONSTRAINT "ComplianceExportBatchRecord_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ComplianceExportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ComplianceExportBatchRecord" ADD CONSTRAINT "ComplianceExportBatchRecord_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "ComplianceRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Immutability: records and batch membership never change; a batch may only move SEALED -> STORED once, recording where it was stored.
CREATE FUNCTION "fbeds_compliance_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "ComplianceRecord_immutable" BEFORE UPDATE OR DELETE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION "fbeds_compliance_immutable"();
CREATE TRIGGER "ComplianceExportBatchRecord_immutable" BEFORE UPDATE OR DELETE ON "ComplianceExportBatchRecord" FOR EACH ROW EXECUTE FUNCTION "fbeds_compliance_immutable"();

CREATE FUNCTION "fbeds_compliance_batch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ComplianceExportBatch is append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."storage_status" <> 'SEALED' OR NEW."storage_status" <> 'STORED'
     OR (to_jsonb(NEW) - 'storage_status' - 'stored_at' - 'object_version_id') <> (to_jsonb(OLD) - 'storage_status' - 'stored_at' - 'object_version_id') THEN
    RAISE EXCEPTION 'ComplianceExportBatch may only move SEALED -> STORED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ComplianceExportBatch_guard" BEFORE UPDATE OR DELETE ON "ComplianceExportBatch" FOR EACH ROW EXECUTE FUNCTION "fbeds_compliance_batch_guard"();

-- Row-level security.
CREATE FUNCTION "fbeds_compliance_scope_visible"(row_tenant TEXT) RETURNS BOOLEAN AS $$
  SELECT CASE WHEN row_tenant IS NULL THEN current_setting('app.compliance_scope', true) = 'platform' ELSE row_tenant = "fbeds_current_tenant_id"() END
$$ LANGUAGE sql STABLE;
CREATE FUNCTION "fbeds_compliance_capture_active"() RETURNS BOOLEAN AS $$
  SELECT current_setting('app.compliance_capture', true) = 'on'
$$ LANGUAGE sql STABLE;

ALTER TABLE "ComplianceRecord" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ComplianceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ComplianceRecord_scope_select" ON "ComplianceRecord" FOR SELECT USING ("fbeds_compliance_scope_visible"("tenant_id"));
CREATE POLICY "ComplianceRecord_capture_insert" ON "ComplianceRecord" FOR INSERT WITH CHECK ("fbeds_compliance_capture_active"());
ALTER TABLE "ComplianceExportBatch" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ComplianceExportBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ComplianceExportBatch_scope" ON "ComplianceExportBatch"
  USING ("fbeds_compliance_scope_visible"("tenant_id")) WITH CHECK ("fbeds_compliance_scope_visible"("tenant_id"));
ALTER TABLE "ComplianceExportBatchRecord" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ComplianceExportBatchRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ComplianceExportBatchRecord_scope" ON "ComplianceExportBatchRecord"
  USING ("fbeds_compliance_scope_visible"("tenant_id")) WITH CHECK ("fbeds_compliance_scope_visible"("tenant_id"));

-- The classifier (generated).
CREATE OR REPLACE FUNCTION "fbeds_compliance_category"(action TEXT) RETURNS "ComplianceCategory" AS $$
  SELECT CASE
    WHEN action IN ('platform.role.created', 'platform.role.updated', 'platform.role.permissions.updated', 'platform.role.assigned', 'platform.role.revoked', 'tenant.membership.changed', 'agency.member.added', 'agency.member.removed') THEN 'RBAC_CHANGE'::"ComplianceCategory"
    WHEN action IN ('platform.tenant.context.entered', 'bootstrap.platform_owner.provisioned', 'bootstrap.tenant_owner.provisioned') THEN 'PRIVILEGED_ACCESS'::"ComplianceCategory"
    WHEN action IN ('permission.denied', 'tenant.access.denied', 'platform.access.denied', 'runtime_role.operation_prohibited') THEN 'ACCESS_DENIAL'::"ComplianceCategory"
    WHEN action IN ('tenant.created', 'tenant.lifecycle.changed', 'tenant.compliance.decided', 'tenant.profile.updated', 'settings.updated', 'agency.suspended', 'agency.reinstated', 'approval.approved', 'approval.rejected', 'approval.executed', 'approval.execution_failed') THEN 'TENANT_GOVERNANCE'::"ComplianceCategory"
    WHEN action IN ('hotel.exported', 'hotel.report.exported', 'platform.tenants.directory.read') THEN 'DATA_EXPORT'::"ComplianceCategory"
    WHEN action IN ('agency.credit_limit.changed', 'funding.declared', 'funding.verified', 'funding.compliance_cleared', 'funding.posted', 'funding.rejected', 'booking.finance.authorized', 'booking.finance.released', 'commercial.markup.activated', 'commercial.markup.retired') THEN 'FINANCIAL_CONTROL'::"ComplianceCategory"
    WHEN action IN ('booking.confirmed', 'booking.cancelled', 'booking.manual.created') THEN 'BOOKING_JURISDICTION'::"ComplianceCategory"
    ELSE NULL
  END
$$ LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp;

-- The capture hook. Runs as the owner so no writer role needs a privilege on ComplianceRecord. It reads the booking's agency and hotel countries in the
-- inserting transaction's tenant. Any failure here fails the audit insert and with it the mutation (fail closed: no mutation without its evidence).
CREATE FUNCTION "fbeds_compliance_capture"() RETURNS trigger AS $$
DECLARE
  category "ComplianceCategory" := "fbeds_compliance_category"(NEW."action");
  origin CHAR(2);
  destination CHAR(2);
BEGIN
  IF category IS NULL THEN
    RETURN NULL;
  END IF;
  IF category = 'BOOKING_JURISDICTION' AND NEW."entity_type" = 'booking' AND NEW."tenant_id" IS NOT NULL THEN
    SELECT a."country_code", h."country_code" INTO origin, destination
      FROM "Booking" b
      JOIN "Hotel" h ON h."id" = b."hotel_id" AND h."tenant_id" = b."tenant_id"
      LEFT JOIN "Agency" a ON a."id" = b."agency_id" AND a."tenant_id" = b."tenant_id"
     WHERE b."tenant_id" = NEW."tenant_id" AND b."id" = NEW."entity_id";
  END IF;
  PERFORM set_config('app.compliance_capture', 'on', true);
  INSERT INTO "ComplianceRecord" ("id", "tenant_id", "category", "action", "entity_type", "entity_id", "actor_type", "user_id", "occurred_at", "payload", "payload_sha256", "origin_country", "destination_country", "cross_border")
  VALUES (NEW."id", NEW."tenant_id", category, NEW."action", NEW."entity_type", NEW."entity_id", NEW."actor_type", NEW."user_id", NEW."created_at", NEW."payload",
          encode(sha256(convert_to(NEW."payload"::text, 'UTF8')), 'hex'), origin, destination,
          CASE WHEN origin IS NULL OR destination IS NULL THEN NULL ELSE origin <> destination END);
  PERFORM set_config('app.compliance_capture', 'off', true);
  RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_compliance_capture"() FROM PUBLIC;
CREATE TRIGGER "AuditEvent_compliance_capture" AFTER INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "fbeds_compliance_capture"();

-- Scopes with work for the exporter. SECURITY DEFINER so the exporter needs no cross-tenant read; it returns scope keys only.
CREATE FUNCTION "fbeds_compliance_due_scopes"() RETURNS SETOF TEXT AS $$
  SELECT COALESCE(r."tenant_id", 'platform') FROM "ComplianceRecord" r
   WHERE NOT EXISTS (SELECT 1 FROM "ComplianceExportBatchRecord" m WHERE m."record_id" = r."id")
  UNION
  SELECT b."scope_key" FROM "ComplianceExportBatch" b WHERE b."storage_status" = 'SEALED'
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_compliance_due_scopes"() FROM PUBLIC;

-- Every scope that has a record or a batch, for the verifier (ids only). Same rules as above.
CREATE FUNCTION "fbeds_compliance_known_scopes"() RETURNS SETOF TEXT AS $$
  SELECT COALESCE(r."tenant_id", 'platform') FROM "ComplianceRecord" r
  UNION
  SELECT b."scope_key" FROM "ComplianceExportBatch" b
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_compliance_known_scopes"() FROM PUBLIC;
