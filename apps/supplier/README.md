# fBeds Supplier Portal

The Supplier Portal is the supplier-authoring workspace for hotel direct suppliers, DMCs, channel managers and bedbanks.

## Current route additions

- `/supplier-profile` — supplier onboarding and profile submission boundary.
- `/inventory` — manual rate and availability staging boundary.

Both routes intentionally show an honest unavailable state until the authenticated API work in GitHub Issue #57 is delivered. They do not generate mock supplier data and cannot activate supply, publish availability, distribute rates, search, recheck, or confirm bookings.

## Supplier permissions

Supplier users may eventually author Draft supplier, hotel, contract, rate-plan and inventory submissions only within their authorised tenant scope. They cannot approve, activate, publish, suspend, expire or administer another supplier's data. The API, RLS and RBAC controls are authoritative; UI controls are not treated as security enforcement.

## API boundary

`lib/supply-api.ts` is the explicit seam for reviewed supplier-workflow API contracts. It returns an unavailable state when `NEXT_PUBLIC_API_URL` is absent. No token, tenant ID, supplier credential or secret is stored in browser state by this boundary.

## Local validation

```bash
pnpm --filter @bedbanks/supplier-portal type-check
pnpm --filter @bedbanks/supplier-portal lint
pnpm --filter @bedbanks/supplier-portal build
```

## Not implemented

Live supplier connectivity, connector credentials, XML/GDS/channel-manager integration, inventory publication, Agent/public search, recheck, booking, cancellation, payments and production enablement are out of scope.
