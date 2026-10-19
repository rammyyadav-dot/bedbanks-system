# Security, access control and CI/CD audit, 2026-10-18

Scope: authorization and tenant isolation controls, GitHub Actions workflows, dependency and secret hygiene, response hardening. Evidence is from reading the code and running the tools named below on branch `claude/tender-wozniak-xcr6u4`.

## What was and was not verified

- Verified here: workflow files, dependency audit, gitleaks over all 220 commits, controller guard coverage by static scan, security headers on a production build, API type-check, lint, the new unit tests, and all four web builds.
- Not run here: the Postgres-backed suites (forced RLS, strict runtime role, tenant control certification). Those run in `ci.yml` and were not re-executed in this session, so this audit does not re-certify database isolation.
- Not verifiable from the repository: GitHub branch protection and required status checks, environment reviewer settings, AWS account state.

## Correction to the brief

`apps/admin/lib/auth/capability-policy.ts` is a 15-line, UX-only gate (its header says the API re-checks every permission). `apps/agent/lib/session-capability.test.mjs` tests the agent portal's `bookingEnabled` flag. Neither is the tenant isolation engine. Isolation is enforced in the API (session, tenant and permission guards, explicit tenant filters checked by `check:tenant-filter`) and in the database (forced RLS and restricted roles, certified in `ci.yml`). `contract-check.yml` and `tenancy-check.yml` are narrow, path-filtered PR checks that `ci.yml` already covers through `check:architecture`.

## Findings and status

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Next.js 16.3.3 in all four web apps: RCE in `next/og` (fixed 16.3.6), SSRF in image optimization (fixed 16.3.8) | Critical | Fixed: 16.3.8, all four apps build |
| 2 | Transitive criticals/highs in prod tree: proxy-addr, multer, lodash, js-yaml, sharp, source-map-js, plus the `shadcn` CLI dragging express, MCP SDK and ts-morph into runtime deps | Critical/High | Fixed with `pnpm.overrides`; `shadcn` moved to devDependencies in admin and agent. Prod audit: 2 critical + 15 high down to 1 high |
| 3 | `deepmerge-ts` via Prisma CLI config loader (needs major bump inside Prisma) | High | Accepted until 2026-12-31 in `security/audit-allowlist.json`, with reason |
| 4 | `ci.yml`, `deploy.yml`, `contract-check.yml`, `tenancy-check.yml` had no `permissions:` block | Medium | Fixed; now enforced by `check:workflow-permissions` |
| 5 | No Dependabot, no code scanning, no secret scanning, no audit gate | Medium | Fixed: `dependabot.yml`, `security.yml`. gitleaks found 36 hits, all idempotency-key and test constants, allowlisted by exact path in `.gitleaks.toml`. No real secret in history |
| 6 | Agent portal, supplier portal and API sent no CSP, HSTS, framing or nosniff headers (admin and website already did) | Medium | Fixed; verified on a production build. Agent/supplier use a non-breaking subset |
| 7 | CODEOWNERS did not cover contracts, Prisma migrations, infra, tools, Dockerfiles, lockfile | Low | Fixed |
| 8 | `ci.yml` had no concurrency control | Low | Fixed for PRs |

## Open items (not changed, need a decision)

1. **Login throttle keys on `req.ip` and the API never sets `trust proxy`.** Behind the portal proxy and the load balancer, every caller can share one address, so the per-address cap (20 failures per 15 minutes) can lock out all sign-ins, or be bypassed if `trust proxy` is later set to `true`. Fix needs the real hop count per environment: add a `TRUST_PROXY_HOPS` setting and test it. Needs an ADR.
2. **Throttle state is per process**, and there is no global API rate limit. ADR 0062 relies on a WAF/edge limit; confirm it exists in the Terraform.
3. **Branch protection.** Confirm `main` requires the five checks the AWS promotion gate names plus the new Security jobs, requires review, and blocks force pushes. One CODEOWNER means the owner cannot get an independent review; add a second reviewer.
4. **Actions are pinned by tag** (`@v4`), not commit SHA. Dependabot will now propose bumps; pin by SHA once that is flowing.
5. **Full CSP for agent and supplier** (`script-src`, `img-src`, `connect-src`) needs a per-app review; the agent renders hotel images.
6. `deploy.yml` is only an echo. Fine as a guard, but do not read it as a deployment control. `aws-deploy.yml` is the real gate and is well built: SHA-validated input, green-check requirement, main-only and staging-first for production, digest pinning, rollback detection.
7. Dev-only advisories remain (about 7 moderate, 7 high, 2 critical across all deps). They do not ship, but should be worked down via Dependabot.

## Controller guard coverage

Of 34 controller files, one (`health.controller.ts`) lacks any permission or guard decorator by static scan. That is expected for a health probe. This is a heuristic; the authoritative route-permission check is `test:security` in `ci.yml`.
