# Runbook: supplier promotion database role (ADR 0084)

Nothing calls the promotion writer yet. Follow these steps only when something is about to invoke `SupplierPromotionService.promote`.

1. **Migrate** with the owner credential (`pnpm --filter @bedbanks/api prisma:migrate:deploy`); applies `202612040001_supplier_promotion`. Never `prisma migrate dev`.
2. **Provision** (owner credential; idempotent; prints no secret):
   ```
   PROVISION_DATABASE_URL=<owner url> SUPPLIER_PROMOTION_LOGIN_PASSWORD=<32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:provision-supplier-promotion-role
   ```
3. **Store** `SUPPLIER_PROMOTION_DATABASE_URL` (that login and password, same host and database) in the secret manager. It must differ from `DATABASE_URL`.
4. **Certify** as the login itself: `SUPPLIER_PROMOTION_DATABASE_URL=<url> pnpm --filter @bedbanks/api ops:verify-supplier-promotion-role`. Continue only on `Result: OK`.
5. **Before the first promotion for a supplier**, tell the mapping reviewers that approving a rate plan mapping hands that plan's prices to the feed (ADR 0082), and check the profile declares `amountBasis: 'NET'`,
   `allotmentSemantics` and `coverageDays`. Read a HELD run before assuming a feed is healthy: `SELECT status, summary FROM "SupplierPromotionRun" ORDER BY created_at DESC` (as the owner, per tenant).
6. **Roll back:** stop the caller, then deprovision the login (`deprovisionPromoteRole`). Rates and availability already written stay; correct them through the normal Admin workflows after reopening the mapping.

Re-run steps 2 and 4 after any migration that adds a column or table the role could reach: provisioning revokes first, so a stale grant cannot survive.
