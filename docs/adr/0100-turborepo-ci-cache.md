# ADR 0100: Turborepo task caching in CI

## Status
Accepted

## Context
`ci.yml` ran `pnpm -r` for type-check, lint and build, re-doing unchanged work on every push. `turbo.json` already defines the task graph and outputs, but CI did not use it.

## Decision
- The `verify` job runs `type-check`, `lint` and `build`, and the e2e job builds the three portals, through `turbo run` with a local `.turbo` cache directory persisted by `actions/cache` (pinned to a commit SHA). The key is per commit with a per-job prefix fallback, so each run starts from the latest cache and saves its own.
- No remote cache and no `TURBO_TOKEN`: nothing secret is added to CI, and fork PRs behave identically. A remote cache can be added later by setting `TURBO_TOKEN`/`TURBO_TEAM`.
- `--env-mode=loose` is used in CI so job env (`DATABASE_URL`, `NEXT_PUBLIC_*`) is not stripped; task hashes still cover the env vars declared in `turbo.json`.
- `test` stays on `pnpm -r`: tests depend on live Postgres/Redis services that are not part of a task hash, so a cache hit could hide a regression.

## Consequences
- Unchanged packages are replayed from cache on later runs. A cache miss costs the same as before.
- Build env that is not declared in `turbo.json` `env` will not invalidate the cache; declare any new build-time variable there.
- Rollback: restore the previous `pnpm -r --if-present` steps in `ci.yml`.
