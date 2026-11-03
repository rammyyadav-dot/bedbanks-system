# ADR 0110: Runtime env files stay out of git and images; the secret scan cannot shrink

Status: Accepted (2026-11-03)

## Context

Each app root keeps a `.env.example` template next to the place a developer copies a runtime `.env` (ADR 0040, `docs/LOCAL_SETUP.md`). `.gitignore` ignored `.env`, `.env.local`, `.env.production` and `.env.staging`, and not `.env.development` or any other `.env.*` name. `.dockerignore` then re-included `**/.env.example`, so `COPY . .` in both image builds sent those templates into the build context. A template that later held a database URL, a Neon API key or an AWS credential would be one exception away from an image layer.

`.gitleaks.toml` already has rules for those three credentials, plus session tokens, JWT secrets, supplier credentials and hard-coded Authorization headers (ADR 0094). The pull-request job scanned the commits a PR adds, and `main` scanned full history. The self-test only required that five custom rules fire, so two rules could be deleted and the job would still pass. The env-example unit test also contained synthetic values that the full-history scan reports, which makes a red secret scan indistinguishable from a real leak.

Gitleaks reads git history. It does not read an ignored `.env` on a laptop or in a workspace. That file is the one a staging connection string would land in.

## Decision

1. `.gitignore` ignores `.env` and `.env.*`, then re-includes `.env.example` only. A tracked runtime env file fails `tools/runtime-env-leak-check.mjs`.
2. `.dockerignore` excludes `.env`, `**/.env` and `**/.env.*` with no exception. Templates are documentation. They are not image inputs. Builds keep receiving public `NEXT_PUBLIC_*` values as build arguments (ADR 0055).
3. The same check reads every workspace dotenv file it can see, including ignored ones, and fails on a Neon API key (`napi_`), an AWS access key id, secret access key or session token, or a database URL with a password whose host is not localhost or an `.example` name. Findings name the file and the rule. They do not print the value. Local `postgres://…@localhost` URLs stay valid.
4. `security.yml` runs on every pull request with no path filter. Its self-test must fire every `fbeds-*` rule in `.gitleaks.toml`, including the seven rules listed in `tools/secret-scan-gate-check.mjs`. A numeric `found -lt N` threshold is rejected. `pnpm check:architecture` runs both checks, and so does the secret-scan job and the optional pre-commit hook.
5. The env-example test uses low-entropy stand-ins so the fixture still fails the checker. Commit `049e50a9` remains in history with the old synthetic strings; those three findings are fingerprint-allowlisted in `.gitleaksignore`. They were never credentials. A new occurrence is not covered.

## Consequences

- Staging and production credentials stay in AWS Secrets Manager, SSM or the GitHub environment. A Neon API key is project-wide (ADR 0075) and must not sit in a workspace dotenv file.
- Developers keep copying `.env.example` to `.env` for localhost. A remote host in that file fails the local check and the pre-commit hook.
- Commit-scoped fingerprints in `.gitleaksignore` still apply only to `gitleaks detect` history scans. This ADR does not turn them into path allowlists.

## Rollback

Restore the previous `.gitignore` and `.dockerignore` blocks, remove `check:runtime-env` and `check:secret-scan-gate` from `check:architecture`, and restore the five-rule self-test in `security.yml`. No schema or runtime behavior changes.
