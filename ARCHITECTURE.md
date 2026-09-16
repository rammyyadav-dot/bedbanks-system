# fBeds architecture

## Current operating model

Next.js applications are deployed independently. `apps/api` is the NestJS control plane, backed by PostgreSQL through Prisma. Authentication uses opaque database-backed sessions: the browser holds a Secure, HttpOnly cookie and PostgreSQL stores only a SHA-256 token hash.

## Target boundaries

- `@bedbanks/contracts`: typed routes and API envelopes shared by API and frontend clients.
- `@bedbanks/domain`: provider-neutral canonical travel types.
- `@bedbanks/money` and `@bedbanks/pricing`: deterministic, integer-minor-unit calculations.
- `@bedbanks/connectors/*`: isolated provider adapters. Provider types do not cross this boundary.
- API tenancy/RBAC/audit services: enforced server-side; frontend checks are user-experience hints only.

## Delivery order

1. Constitution, contracts, CI and architecture checks.
2. Tenant context/RBAC/audit generalization with PostgreSQL-backed tests.
3. Hotel, room, contract and inventory canonical models.
4. Pricing/search orchestration, then booking/idempotency/finance.
5. Connector registry and supplier/partner distribution capabilities.

The repository may contain screens and schema models ahead of their working services. They are not production capability claims.
