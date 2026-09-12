# FBEDS Monorepo Structure

## Overview

This is a pnpm monorepo using Turbo for build orchestration. It's organized into applications and shared packages.

## Target Directory Structure

This is the corrected, canonical target structure — the one to build
toward, not necessarily what exists in full today (see "Current status"
below for what's actually built vs. planned).

```
bedbanks-system/
├── apps/
│   ├── website/         # PUBLIC fBeds website (marketing/public-facing) — planned, not yet scaffolded
│   ├── agent/            # B2B Agent Portal (Next.js) — built
│   ├── admin/              # Admin Console / control plane (Next.js) — built
│   └── api/                  # Backend API (NestJS) — built
│
├── packages/
│   ├── ui/               # Shared UI Components
│   ├── types/              # Shared TypeScript Types
│   ├── validation/           # Zod Validation Schemas
│   └── config/                 # Shared Configuration
│
├── prisma/                # Prisma schema + migrations — lives at REPO ROOT,
│                             not nested under apps/api/. Multiple future
│                             services may need the same schema/generated
│                             client, not just the API app.
│
├── docs/                  # Documentation
├── .github/                # GitHub Actions & CI/CD
├── pnpm-workspace.yaml       # Workspace configuration
├── turbo.json                  # Turbo build configuration
└── tsconfig.json                 # Root TypeScript configuration
```

**`apps/supplier` (supplier extranet)** is not in the current target
tree — it may return as a later phase once supplier integrations are
actually being built; not tracked as "planned" right now to avoid
scaffolding something with no near-term owner.

## Current Status (update this section as phases land)

| App/Package | Status |
|---|---|
| `apps/agent` | Built — agent portal UI, mock data |
| `apps/admin` | Built — 20 modules, 29 routes, mock data, authenticated (P0-D) |
| `apps/api` | Built — NestJS foundation (P0-B), Prisma/Postgres (P0-C), authentication (P0-D) |
| `apps/website` | Not yet scaffolded — separate task |
| `prisma/` | At repo root as of P0-D (moved from `apps/api/prisma/`) |
| `packages/ui` | Built — shared Button + design tokens |
| `packages/types`, `packages/validation`, `packages/config` | Scaffolded, mostly empty — populate as needed |

## Getting Started

### Installation

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install all dependencies
pnpm install
```

### Database

Prisma schema and migrations live at `prisma/` (repo root). Commands
are run via the `apps/api` package scripts, which already point at the
correct schema path — see `prisma/MIGRATIONS.md` for the full workflow.

```bash
pnpm --filter @bedbanks/api prisma:migrate:dev
pnpm --filter @bedbanks/api db:seed
```
