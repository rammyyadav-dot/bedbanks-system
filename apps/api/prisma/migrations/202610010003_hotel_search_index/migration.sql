-- Hotel identity index for hybrid candidate retrieval.
-- pgvector HNSW is the approximate neighbor index. pg_trgm supports normalized
-- name and address lookup. Neither signal may approve a mapping alone.
-- Rollback: DROP TABLE "HotelSearchIndex"; the extensions may stay because
-- other databases on this cluster can use them.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE "HotelSearchIndex" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "normalized_address" TEXT NOT NULL,
  "normalized_city" TEXT NOT NULL,
  "normalized_country_code" CHAR(2) NOT NULL,
  "latitude" DECIMAL(9,6),
  "longitude" DECIMAL(9,6),
  "embedding" vector(64) NOT NULL,
  "embedding_model" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelSearchIndex_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HotelSearchIndex_tenant_id_hotel_id_key" ON "HotelSearchIndex"("tenant_id", "hotel_id");
CREATE INDEX "HotelSearchIndex_tenant_id_normalized_country_code_normaliz_idx" ON "HotelSearchIndex"("tenant_id", "normalized_country_code", "normalized_city");
CREATE INDEX "HotelSearchIndex_name_trgm" ON "HotelSearchIndex" USING gin ("normalized_name" gin_trgm_ops);
CREATE INDEX "HotelSearchIndex_address_trgm" ON "HotelSearchIndex" USING gin ("normalized_address" gin_trgm_ops);
CREATE INDEX "HotelSearchIndex_embedding_hnsw" ON "HotelSearchIndex" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "HotelSearchIndex" ADD CONSTRAINT "HotelSearchIndex_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelSearchIndex" ADD CONSTRAINT "HotelSearchIndex_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HotelSearchIndex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HotelSearchIndex" FORCE ROW LEVEL SECURITY;
CREATE POLICY "HotelSearchIndex_tenant_isolation" ON "HotelSearchIndex"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    GRANT SELECT ON "HotelSearchIndex" TO fbeds_api;
  END IF;
END $$;
