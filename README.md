# fBeds

fBeds is a multi-tenant B2B hotel bedbank and travel-distribution platform. It connects contracted hotel supply with travel buyers through separate public, agent, operations and supplier experiences, governed by a NestJS API and PostgreSQL.

> **Product status:** the repository contains production-oriented foundations and planned application surfaces. A screen or schema is not, by itself, a live supplier, booking, payment or fulfilment capability.

## Platform

| Application | Responsibility |
| --- | --- |
| `apps/website` | Public fBeds marketing and corporate website |
| `apps/agent` | Tenant-scoped B2B buyer portal for search, rates and booking operations |
| `apps/admin` | Internal operations, catalogue, supplier, commercial and audit workflows |
| `apps/supplier` | Hotel/DMC extranet for supply, contracts, rates, inventory and booking operations |
| `apps/api` | NestJS control plane, Prisma data layer, tenancy, RBAC, audit and orchestration |

## Architecture principles

- **Independent applications:** each Next.js app deploys independently.
- **Server-side controls:** tenancy, RBAC and audit are enforced in the API; frontend checks improve UX but are not authorization.
- **Secure sessions:** browser sessions use Secure, HttpOnly cookies; only a SHA-256 token hash is stored in PostgreSQL.
- **Canonical travel domain:** supplier/provider formats remain isolated behind connector boundaries.
- **Financial correctness:** money and pricing calculations use deterministic integer minor units—never floating-point values.
- **No silent fallbacks:** unavailable supplier capabilities must surface truthfully rather than appear as live inventory.

Read [Architecture](ARCHITECTURE.md) for the operating model, target boundaries and delivery sequence.

## Repository layout

```text
apps/
  website/     public website
  agent/       B2B buyer portal
  admin/       internal operations console
  supplier/    hotel & DMC extranet
  api/         NestJS API + Prisma
packages/      shared contracts, domain, pricing and connector packages
docs/          delivery, operational and setup documentation
tools/         repository guardrails
```

## Getting started

### Prerequisites

- Node.js 24.x
- pnpm 10+
- PostgreSQL for API-backed development

### Install and validate

Copy the applicable `.env.example` files and configure a local `DATABASE_URL` before running API-dependent commands.

```sh
pnpm install --frozen-lockfile
pnpm --filter @bedbanks/api prisma:generate
pnpm type-check
pnpm lint
pnpm test
pnpm check:architecture
```

## Development guidance

- Make public website changes only in `apps/website/`.
- Keep Agent, Admin, Supplier and API changes within their respective ownership boundaries.
- Use `@bedbanks/contracts` for typed API routes/envelopes and `@bedbanks/domain` for provider-neutral models.
- Put external-provider logic in `@bedbanks/connectors/*`; do not leak provider-specific types into core application code.
- Do not bypass tenant context, RBAC, audit, money/pricing, or migration gates.

Before contributing, read the [repository constitution](CLAUDE.md), [local setup guide](docs/LOCAL_SETUP.md), and [database migration gates](apps/api/prisma/MIGRATIONS.md).

## Delivery roadmap

1. Tenant context, RBAC and audit generalization.
2. Canonical hotel, room, contract and inventory models.
3. Pricing and search orchestration.
4. Booking idempotency, cancellation and finance workflows.
5. Supplier connectors and partner distribution capabilities.

## Security and release expectations

Do not commit credentials, production data or real customer sessions. Treat any seeded accounts and mock inventory as non-production only. Production releases require validated supplier connectivity, transactional booking/cancellation handling, finance controls, observability and the relevant migration/release gates.
