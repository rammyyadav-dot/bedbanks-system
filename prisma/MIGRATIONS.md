# FBEDS — Database Migrations

> **Schema location:** `prisma/schema.prisma` lives at the **repository root**, not under `apps/api/`. All commands below are still run from `apps/api` (e.g. `pnpm --filter @bedbanks/api prisma:migrate:dev`) — the scripts in `apps/api/package.json` already point `--schema` at `../../prisma/schema.prisma`, so you don't need to pass that flag yourself.

## Local development

```bash
# 1. Copy the example env and point it at your local Postgres
cp .env.example .env

# 2. Create/update the schema and generate a migration
pnpm prisma:migrate:dev

# 3. (Optional) seed demo data
pnpm db:seed

# 4. (Optional) browse the database visually
pnpm prisma:studio
```

`prisma migrate dev`:
- Compares `prisma/schema.prisma` against the database's migration history
- Generates a new SQL migration file under `prisma/migrations/` if the schema changed
- Applies it immediately to your local database
- Regenerates the Prisma Client

**Commit the generated `prisma/migrations/` folder to git.** Migration
files are part of the schema's history, not a build artifact — every
environment (a teammate's laptop, CI, production) replays the same
migration files to reach the same schema. Never hand-edit a migration
file that's already been applied anywhere but your own machine; if the
schema needs to change further, generate a new migration.

## Staging / Production

```bash
pnpm prisma:migrate:deploy
```

`prisma migrate deploy` (**not** `migrate dev`):
- Applies any pending migrations from `prisma/migrations/` in order
- Never generates new migrations
- Never prompts interactively
- Never resets or drops data

**Never run `prisma migrate dev` against a staging or production
database.** It's an interactive, schema-drift-resolving command that
can prompt to reset the database if it detects drift — the wrong tool
entirely once real data exists. `migrate deploy` is the only command
that belongs in a deploy pipeline.

## Rule of thumb

| Environment | Command |
|---|---|
| Your laptop | `prisma migrate dev` |
| CI / staging / production | `prisma migrate deploy` |

## What P0-C does NOT set up

No production AWS database, no CI pipeline running `migrate deploy`
automatically yet, no backup/restore strategy. Those are deliberately
later work — P0-C's job is a correct, safe *workflow* that later
phases plug into, not the infrastructure itself.
