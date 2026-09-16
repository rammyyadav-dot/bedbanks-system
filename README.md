# fBeds

fBeds is an enterprise B2B hotel bedbank and distribution platform. It has separate public, agent, admin and supplier applications backed by a NestJS API and PostgreSQL.

## Applications

| App | Purpose |
| --- | --- |
| `apps/website` | Public marketing site |
| `apps/agent` | B2B buyer portal |
| `apps/admin` | Internal operations console |
| `apps/supplier` | Future hotel/DMC extranet |
| `apps/api` | NestJS API and Prisma database layer |

## Local setup

Use Node 24 and pnpm 10. Copy each required `.env.example` file, configure a local PostgreSQL `DATABASE_URL`, then run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @bedbanks/api prisma:generate
pnpm type-check
pnpm lint
pnpm test
```

Read [Architecture](ARCHITECTURE.md), [local setup](docs/LOCAL_SETUP.md), and the [repository constitution](CLAUDE.md) before making changes. Database migration release gates are documented in `apps/api/prisma/MIGRATIONS.md`.
