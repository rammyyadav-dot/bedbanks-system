# ADR 0108: Shared types, validation and API client

## Status

Accepted.

## Context

ADR 0075 recorded `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` as unused, and proposed deleting them because `@bedbanks/types` advertised a float `Money { amount: number }` (invariant 3) and unused packages advertise capabilities nobody consumes (invariant 10).

The Agent and Admin already call the NestJS API at `/api/v1` through audience-specific clients (`apps/agent/lib/api-client.ts`, `apps/admin/lib/api/*`). Auth, search, hotels and bookings are live controllers (`/auth/*`, `/agent/search`, `/agent/bookings`, `/agent/hotels/:hotelId/images/...`). Prisma already models `User.passwordHash` and `Session`; those landed in `20260910000000_p0d_authentication`. There is no `packages/api-client`.

The remaining gap is a shared, contract-aligned TypeScript and Zod layer that Agent, Admin and the API can import without inventing parallel `/hotels`, `/search` or `/bookings` resources or a float money type.

## Decision

1. Keep `@bedbanks/types` and `@bedbanks/validation`. They are no longer placeholders.
2. `Money` is `{ amountMinor: number; currency: string }` only. A float `amount` field is forbidden.
3. Zod schemas that both a browser and the API need live in `@bedbanks/validation`. The Agent may import only `@bedbanks/validation/agent` so B2B distribution schemas (and the root `@bedbanks/contracts` barrel they use) do not enter the agency bundle. `tools/app-boundary-check.ts` enforces that split.
4. Add `@bedbanks/api-client` as a transport helper: envelope unwrap, credentialed `fetch`, and an Agent entry that imports `@bedbanks/contracts/agent` only. App-specific session events, tenant headers and booking outcome mapping stay in each app.
5. Do not add alias NestJS controllers at `/hotels`, `/search` or `/bookings`. The published paths remain those in `@bedbanks/contracts`. `domainRoutes` in `@bedbanks/types` documents the mapping.
6. Do not add a second Prisma `Session` model or a second `passwordHash` column. Do not invent a new migration for schema that already has history.

This amends ADR 0075 phase 4: the packages are populated and consumed instead of deleted. `@bedbanks/config` stays unused and is not advertised as a production surface.

## Consequences

- Agent sign-in validates with `loginRequestSchema` before `POST /api/v1/auth/login`.
- Search and booking clients resolve paths from `routes.agent`.
- Admin auth identity types come from `@bedbanks/types`.
- A later Admin/Supplier audience split for `@bedbanks/api-client` is optional and only needed if a measured bundle leak appears.
