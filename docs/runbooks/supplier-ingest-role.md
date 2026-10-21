# Runbook: supplier ingestion database role (ADR 0079)

Nothing uses this role yet. Follow these steps only when a worker is about to be enabled.

1. **Migrate** with the owner credential (`pnpm --filter @bedbanks/api prisma:migrate:deploy`); applies `202612020001` (tables, ADR 0078) and `202612020002` (system audit policy). Never `prisma migrate dev`.
2. **Provision** (owner credential; idempotent; prints no secret):
   ```
   PROVISION_DATABASE_URL=<owner url> SUPPLIER_INGEST_LOGIN_PASSWORD=<32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:provision-supplier-ingest-role
   ```
3. **Store** `SUPPLIER_INGEST_DATABASE_URL` (that login and password, same host and database) in the secret manager. It must differ from `DATABASE_URL`.
4. **Certify** as the login itself: `SUPPLIER_INGEST_DATABASE_URL=<url> pnpm --filter @bedbanks/api ops:verify-supplier-ingest-role`. Continue only on `Result: OK`.
5. **Roll back:** stop the worker, then deprovision the login (`deprovisionIngestRole`). Ingestion rows stay; they are evidence.

Re-run steps 2 and 4 after any migration that adds a column or table the role could reach: provisioning revokes first, so a stale grant cannot survive.
