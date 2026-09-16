# Migration history and P0-D release gate

Inspected main: e03f8d2d8cfbb34b7d068a3106039743172b2a34.
Schema: `apps/api/prisma/schema.prisma`. Run commands below from `apps/api`.

## Existing history (preserved)

1. `20260101000000_baseline_identity`: P0-C Tenant/User/Membership baseline.
2. `20260910000000_p0d_authentication`: Status enum, user credential/lifecycle fields and opaque sessions. Only SHA-256 session token hashes are stored.
3. `202609160001_agent_domain_foundation`: currently a full-schema creation script, not an incremental migration. It repeats the first two migrations' enum, tables, indexes and foreign keys.

**Release blocked:** replaying this chain on a fresh database encounters duplicate objects in migration 3. Do not deploy this chain or seed an existing database until its migration history is reconciled. Do not replace the baseline with a diff from empty to the current full schema: that would duplicate P0-D and later models again.

The P0-D hardening branch preserves schema and all existing SQL bytes. Their actual application state in other environments is unknown. Do not silently rewrite checksummed migrations. No new P0-D migration is necessary for the code-only fixes.

## Required history inspection

Have the database owner inspect `_prisma_migrations` on each environment (read-only), including migration_name, checksum, finished_at, rolled_back_at and applied_steps_count; inspect actual schema with Prisma diff. Do not share database credentials or raw customer data in the report.

- If migration 3 has **never** been applied anywhere, replace only that migration with a reviewed incremental diff from the baseline + P0-D state to the current schema. Replay all three in a disposable PostgreSQL database, confirm no drift, then deploy through the normal release process.
- If migration 3 was applied standalone or manually baselined, first document which SQL objects and migration records really exist. Create an environment-specific reconciliation procedure, with backups and reviewed checksums. Do not blindly mark earlier migrations applied.
- A new migration after migration 3 cannot fix its earlier duplicate-object failure.

## Commands and acceptance gates

```sh
pnpm prisma:validate
pnpm prisma:generate
# Only after the conflicting migration history is resolved, with a disposable DB:
pnpm prisma:migrate:deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

Use `migrate diff --from-empty` only against a verified historical **P0-C-only** schema when assessing the baseline. Use `migrate resolve --applied` only after proving the exact migration's objects already exist and obtaining the database owner's approval. Never use `migrate dev`, `db push`, `migrate reset`, or guessed schema generation for this task.

Rollback: the hardening change has no database migration. Revert application commits if necessary; do not drop identity/session tables. Keep Secure-cookie configuration and do not restore broken cookie forwarding. Real PostgreSQL replay, drift checks and authentication integration remain release gates until they actually pass.
