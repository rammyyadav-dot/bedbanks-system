# ADR 0107: Market Validity, Source Market Profiling & Grouping

Status: Accepted.

## Context

In wholesale bedbank distribution, a single hotel contract can carry multiple rate plans bound to structured Source Market Validities (geo-targeting rules). While `Contract.salesMarkets` and `RatePlan.salesMarkets` provide flat ISO-3166-1 alpha-2 allow-lists (ADR 0035, ADR 0057), operators also need:

1. Reusable, tenant-scoped **Source Market Groups** (e.g., `GCC`, `CIS`, `DOMESTIC_IN`, `EU_SCHENGEN`) bundling ISO 3166-1 alpha-2 country codes.
2. Explicit **Market Validity Rules** (`INCLUDE` or `EXCLUDE`) matching `COUNTRY_CODE`, `MARKET_GROUP`, or `WORLDWIDE`, attached either to a whole `Contract` (`ratePlanId = null`) or to a specific `RatePlan`.
3. A deterministic evaluation engine (`MarketValidityService`) and an interactive simulator in `apps/admin` so operators can test how any guest nationality / point-of-sale ISO country code resolves against a contract and its rate plans.

## Decisions

### 1. Canonical Schema (`SourceMarketGroup` and `MarketValidityRule`)
- `SourceMarketGroup` stores `tenantId`, `code` (`@@unique([tenantId, code])`), `name`, `countryCodes` (`String[]` of uppercase ISO 3166-1 alpha-2 codes), and `isActive`.
- `MarketValidityRule` stores `tenantId`, `contractId`, optional `ratePlanId`, `inclusionType` (`INCLUDE` | `EXCLUDE`), `matchType` (`COUNTRY_CODE` | `MARKET_GROUP` | `WORLDWIDE`), `countryCodes` (`String[]`), and optional `marketGroupId`.
- Both tables enforce `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` bound to `fbeds_current_tenant_id()`. Every foreign key column leads an index (`SourceMarketGroup(tenant_id)`, `MarketValidityRule(tenant_id, contract_id)`, `MarketValidityRule(contract_id)`, `MarketValidityRule(rate_plan_id)`, `MarketValidityRule(market_group_id)`).

### 2. Evaluation Precedence (`MarketValidityService`)
- **Explicit Rate Plan Rules** (`ratePlanId = plan.id`) override **Contract-level Rules** (`ratePlanId = null`). When a rate plan has no explicit rules of its own, evaluation falls back to the contract's rules (`ratePlanId = null`).
- If neither the rate plan nor the contract has any market validity rules configured, the rate plan defaults to open worldwide (`isValid: true, matchedRuleId: null, reason: 'worldwide_default'`).
- **EXCLUDE rules** take absolute fail-safe precedence over **INCLUDE rules**: if any matching rule has `inclusionType === 'EXCLUDE'`, evaluation immediately returns `{ isValid: false, matchedRuleId: rule.id, reason: 'explicitly_excluded_by_source_market' }`.
- For `MARKET_GROUP` rules, only an active `SourceMarketGroup` belonging to the same tenant matches its `countryCodes`.

### 3. Transport, RBAC & Audit
- All routes and payloads are declared in `@bedbanks/contracts` (`supply.ts` and `routes.ts`):
  - `GET /supply/source-market-groups` (`supply.contracts.read`) and `POST /supply/source-market-groups` (`supply.contracts.manage`)
  - `GET /supply/contracts/:contractId/market-validity` (`supply.contracts.read`) and `POST /supply/contracts/:contractId/market-validity` (`supply.contracts.manage`)
  - `POST /supply/rate-plans/:ratePlanId/validate-market` (`supply.contracts.read`)
- Every tenant-scoped query binds `tenantId` from the authenticated server context, and mutations emit immutable audit events via `SupplyService.write`.

### 4. Admin Console (`apps/admin`)
- `app/(dashboard)/market-groups`: Source Market Group Manager for creating and updating named geo-bundles of ISO country codes.
- `app/(dashboard)/contracts/[id]`: Contract & Rate Plan Validity Matrix and live Simulator tool to configure contract/rate-plan inclusion and exclusion rules and test guest nationalities / source market codes against the contract's rate plans.

## Deployment and Rollback

Apply forward migration `202612190001_market_validity_profiling` and regenerate Prisma Client. To roll back, revert the application deployment first, then drop `MarketValidityRule`, `SourceMarketGroup`, `MarketMatchType`, and `MarketInclusion` in a reviewed forward migration.
