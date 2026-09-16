# fBeds repository constitution

Read this before every AI-assisted change.

## Non-negotiable invariants

1. Tenant identity comes only from authenticated server context; never trust a body, query or browser-selected tenant ID.
2. Authentication is not authorization. Every tenant-scoped API controller declares and verifies a permission.
3. Money is integer minor units plus ISO-4217 currency. No floating-point arithmetic in pricing, finance, booking or connector code.
4. API routes and envelopes live in `@bedbanks/contracts` before a frontend consumes them.
5. Supplier failures are observable. Never return demo, stale or zero-priced inventory from a catch block without an explicit policy.
6. Booking, cancellation, wallet, payment and webhook mutations require idempotency.
7. Store only encrypted credential values or secret references. Never log tokens, credentials, guest PII or raw supplier payloads.
8. Privileged and financial mutations create immutable audit events.
9. Provider-specific types stay in their connector package and map to canonical domain types at the boundary.
10. Never present a UI route, schema model or placeholder module as a production capability.
11. `apps/api/prisma/schema.prisma` is the only permitted Prisma schema source. Do not add another `schema.prisma` outside `node_modules`; keep `pnpm check:schema` and the CI Schema integrity job enabled.

## Change protocol

- Inspect actual code and migrations before choosing an implementation.
- Work on a feature branch; keep changes small and reviewable.
- Run `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test`, and affected builds.
- Database changes require a reviewed Prisma migration, rollback notes and tenant-index review. Never use `prisma migrate dev` to invent production history.
- Architectural choices require an ADR in `docs/adr`.

## Dependency direction

Apps may depend on shared packages. Shared packages must not import from apps. The domain, pricing, money and connector packages are transport-agnostic. API modules orchestrate them; frontends consume contracts only.
