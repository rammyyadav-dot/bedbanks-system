# ADR 0094: CI security and migration-safety gates

## Status
Accepted

## Context
Secrets, hand-built SQL and unsafe migrations are the failures that cannot be undone by a revert. Existing gates covered SHA pinning, dependency advisories, CodeQL and a gitleaks scan, but not connection strings, supplier or JWT secrets, raw-SQL injection shapes, or migration content.

## Decision
- `.gitleaks.toml` adds rules for database URLs with passwords, Neon API keys, AWS secret keys and session tokens, JWT/session signing secrets, supplier credentials and hard-coded Authorization headers. Placeholders are exempted per rule by stopword, never by path. The workflow self-tests the rules against synthetic secrets.
- Pull requests and branch pushes scan their own commit range; `main` and the weekly schedule scan full history.
- `tools/raw-sql-check.ts` and ESLint `no-restricted-syntax` reject hand-built SQL text. Unsafe raw calls exist only for DDL and role administration and are capped per file by `security/raw-sql-baseline.json` (ratchet down only).
- `tools/migration-safety-check.mjs` requires leading indexes on foreign keys (baselined) and reviews migrations added by a PR for breaking or lock-heavy statements.
- No new dependency: the checks use the TypeScript compiler already in the API workspace, Node's test runner, and built-in ESLint rules.

## Consequences
New unsafe SQL, unindexed foreign keys and risky migration statements fail the PR with a summary that states the fix. Reviewed exceptions are explicit and greppable. The baselines list pre-existing debt (31 files with unsafe DDL helpers, 56 unindexed foreign keys, mostly audit-actor user ids) to be paid down.

## Rollback
Remove the new steps from `contract-check.yml`, the added rules from `.gitleaks.toml`, and the `check:raw-sql` / `check:migration-safety` entries from `check:architecture`. No runtime or schema change is involved.
