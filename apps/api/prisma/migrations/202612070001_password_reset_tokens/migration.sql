-- ADR 0091: single-use password-reset tokens.
--
-- Hand-authored to match schema.prisma; the "Prisma migration certification" job (migrate deploy + drift check) is the gate.
-- Never generated with `prisma migrate dev`.
--
-- Tenant-index review: user-scoped, not tenant-scoped, exactly like "sessions" (a user exists before any tenant context, and a reset
-- runs before sign-in). It therefore has no tenant_id and no RLS policy. Lookups are by the unique token_hash; user_id and expires_at
-- are indexed for supersede-on-request and for expiry clean-up. Only SHA-256(token) is stored.
--
-- Rollback: DROP TABLE "password_reset_tokens"; (nothing else references it and no existing table changes).

CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Runtime privileges are granted by 202612070002_strict_runtime_role_password_reset, which mirrors runtime-role-contract.ts.
