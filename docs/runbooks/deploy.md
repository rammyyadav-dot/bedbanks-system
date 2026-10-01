# Deploy runbook

1. Confirm CI, migration status and database backup.
2. Run `prisma migrate deploy` only after reviewed migrations are available.
3. Deploy API before dependent applications.
4. Run the HTTPS authentication and golden-path smoke checks.
5. Record deployment version, migration state and rollback point.

Website: deploy only from a Vercel project with Root Directory `apps/website`; Admin, Agent and Supplier are separate projects (ADR 0011). See `apps/website/README.md`.
