# FBEDS Monorepo Structure

## Overview

This is a pnpm monorepo using Turbo. Applications talk to the NestJS API through `/api/v1`. Shared packages hold contracts, types, validation and presentational UI — never Prisma or NestJS (ADR 0075, ADR 0108).

## Directory Structure

```
bedbanks-system/
├── apps/
│   ├── agent/          # B2B Agent Portal (Next.js)
│   ├── api/            # NestJS API (`/api/v1`, Prisma, Neon PostgreSQL)
│   ├── admin/          # Admin Console (Next.js)
│   ├── supplier/       # Supplier Extranet (Next.js)
│   └── website/        # Public marketing site
│
├── packages/
│   ├── contracts/      # Routes, DTOs, envelopes (`@bedbanks/contracts`, `./agent`)
│   ├── types/          # Shared TypeScript types (integer minor-unit money)
│   ├── validation/     # Zod schemas (`@bedbanks/validation`, `./agent`)
│   ├── api-client/     # Shared HTTP envelope client (`@bedbanks/api-client`, `./agent`)
│   ├── domain/         # Provider-neutral search/booking types
│   ├── money/          # Integer minor-unit arithmetic
│   ├── pricing/        # Pure basis-point arithmetic
│   ├── ui/             # Presentational components
│   ├── tracing/        # OpenTelemetry bootstrap
│   └── connectors/     # Server-only supplier adapters
│
├── docs/
├── .github/
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json
```

## Getting Started

```bash
pnpm install
pnpm dev
```

The Agent reaches `POST /api/v1/auth/login`, `POST /api/v1/agent/search` and `/api/v1/agent/bookings` through `@bedbanks/api-client/agent` and `@bedbanks/contracts/agent`. Hotel images use `GET /api/v1/agent/hotels/:hotelId/images/:imageId/content`. Admin uses the same prefix via the same-origin proxy.

## Workspace dependencies

Use `workspace:*` for internal packages. The Agent may import only `@bedbanks/contracts/agent` and `@bedbanks/validation/agent`.

## Database

The Prisma schema and migration chain live in `apps/api/prisma`. `User.passwordHash` and `Session` were added in `20260910000000_p0d_authentication`. Do not run `prisma migrate dev` to invent production history.
