-- Baseline migration: the P0-C identity schema (Tenant, User, Membership).
--
-- HAND-AUTHORED, NOT engine-generated: `prisma migrate dev` requires
-- downloading a schema-engine binary from binaries.prisma.sh, which is
-- network-blocked in the sandbox this was written in. This SQL was
-- written to match Prisma's standard migration output conventions
-- exactly (TIMESTAMP(3) precision, quoted identifiers, this exact
-- constraint-naming pattern) but has NOT been verified by an actual
-- `prisma migrate diff` against the schema. Before this is trusted as
-- the real baseline, run, on a machine with network access:
--   npx prisma migrate diff \
--     --from-empty \
--     --to-schema-datamodel apps/api/prisma/schema.prisma \
--     --script
-- and confirm it matches (or replace this file with its output).

CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE INDEX "memberships_tenant_id_idx" ON "memberships"("tenant_id");

CREATE UNIQUE INDEX "memberships_user_id_tenant_id_key" ON "memberships"("user_id", "tenant_id");

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
