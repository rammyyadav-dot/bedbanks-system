# Migration history and P0-D release gate

Inspected main: e03f8d2d8cfbb34b7d068a3106039743172b2a34.
Schema: `apps/api/prisma/schema.prisma`. Run commands below from `apps/api`.

## Existing history (preserved)

1. `20260101000000_baseline_identity`: P0-C Tenant/User/Membership baseline.
2. `20260910000000_p0d_authentication`: Status enum, user credential/lifecycle fields and opaque sessions. Only SHA-256 session token hashes are stored.
3. `202609160001_agent_domain_foundation`: incremental Agent domain migration. It adds roles, permissions, bookings, wallet/ledger and audit models after the P0-C and P0-D migrations.

The database owner confirmed that the former conflicting third migration had not been applied to a real environment. It was therefore safely replaced with the reviewed incremental diff before release. The chain must still be replayed in disposable PostgreSQL and checked for drift in CI before any production deployment.

## Commands and acceptance gates

```sh
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

Use `migrate diff --from-empty` only against a verified historical **P0-C-only** schema when assessing the baseline. Use `migrate resolve --applied` only after proving the exact migration's objects already exist and obtaining the database owner's approval. Never use `migrate dev`, `db push`, `migrate reset`, or guessed schema generation for this task.

Rollback: revert application commits if necessary; do not drop identity/session tables. Keep Secure-cookie configuration and do not restore broken cookie forwarding. Real PostgreSQL replay, drift checks and authentication integration remain release gates until they actually pass.
