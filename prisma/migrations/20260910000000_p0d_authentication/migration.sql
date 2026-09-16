-- P0-D: authentication. Adds Status enum, credentials/lifecycle fields
-- on User and Tenant, and the Session table for opaque database-backed
-- sessions.
--
-- HAND-AUTHORED, NOT engine-generated — same caveat as the baseline
-- migration in this repo: verify with `prisma migrate diff` against a
-- real Postgres before trusting this as final. See that file's header
-- for the exact command.

CREATE TYPE "Status" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "tenants" ADD COLUMN "status" "Status" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "status" "Status" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "user_id" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
