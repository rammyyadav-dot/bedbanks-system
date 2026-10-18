# ADR 0072: Supply-chain and workflow security gates

Status: Accepted (2026-10-18)

## Context

The 2026-10-18 security audit (`docs/security-access-cicd-audit-2026-10-18.md`) found production dependencies with 2 critical and 15 high advisories (Next.js RCE and SSRF in all four web apps, plus transitive packages), four workflows with no `permissions:` block, no Dependabot, no code scanning, no secret scanning, and no security response headers on the agent portal, supplier portal or API.

## Decision

1. `security.yml` runs on every PR, on main and weekly: a production dependency audit gate, GitHub dependency review for new packages, CodeQL `security-extended`, and a gitleaks full-history scan.
2. The audit gate (`tools/dependency-audit-check.mjs`) fails on any high or critical production advisory not listed in `security/audit-allowlist.json`. Every allowlist entry needs a reason and an expiry date; an expired entry fails the gate.
3. Every workflow must declare top-level `permissions:`, never `write-all`, and never `pull_request_target` (`tools/workflow-permissions-check.mjs`, part of `check:architecture`).
4. Transitive fixes use `pnpm.overrides` in the root `package.json`. CLI-only tooling (`shadcn`) is a devDependency.
5. All web apps and the API send baseline security headers. Agent and supplier use a non-breaking subset (no `script-src`/`img-src`) until a per-app CSP review.

## Consequences

- A new high/critical production advisory turns the Security workflow red until fixed, overridden or consciously accepted with an expiry.
- Overrides must be revisited when the parent package ships its own fix; Dependabot PRs are the prompt.
- The API now defaults `Cache-Control: no-store`; any route that wants caching must set its own header.

## Rollback

Revert the commit. No schema or data changes are involved.
