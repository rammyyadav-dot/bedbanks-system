# Vercel deployment topology and verification

## Release scope
This change fixes frontend deployment configuration. It does not authorize production deployment, alias cutover, API deployment, persistent migrations, booking/payment activation, live suppliers or transaction workers.

## Required projects
| App | Proposed project name | Root Directory | Build filter |
| --- | --- | --- | --- |
| Website | fbeds-website | apps/website | @bedbanks/website |
| Agent | fbeds-agent | apps/agent | @bedbanks/agent-portal |
| Admin | fbeds-admin | apps/admin | @bedbanks/admin-console |
| Supplier | fbeds-supplier | apps/supplier | @bedbanks/supplier-portal |

Project names are proposed, not evidence that projects exist. Discover IDs before any operation.
Set Root Directory in each Vercel project; it is not a vercel.json field. Connect rammyyadav-dot/bedbanks-system, use main as production branch, Next.js framework and Node 24.x.
Enable source files outside the Root Directory for shared workspace packages and tools/deployment/api-url.mjs. Install from the repository workspace with pnpm@10.4.1 and the frozen lockfile. App vercel.json files select one build filter. Leave Next.js output detection at its framework default. Do not copy .next or create manual dependency symlinks.
Verify ignored-build behavior understands shared package, lockfile and tools changes before relying on skip optimization.

## Environment matrix
| App | Names | Scope |
| --- | --- | --- |
| Website | NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_AGENT_URL, NEXT_PUBLIC_ADMIN_URL, NEXT_PUBLIC_SUPPLIER_URL, NEXT_PUBLIC_CONTACT_EMAIL | Separate Preview and Production public values |
| Website leads | FBEDS_LEAD_ENDPOINT_URL, FBEDS_LEAD_SIGNING_SECRET | Server-only; keep unset until delivery is approved |
| Agent | API_INTERNAL_URL; NEXT_PUBLIC_AGENT_API_URL only if required | Separate Preview and Production; browser default /api/v1 |
| Admin | API_INTERNAL_URL, AUTH_API_ORIGIN, AUTH_COOKIE_NAME | Separate Preview and Production server values |
| Supplier | API_INTERNAL_URL, SUPPLIER_ORIGIN, AUTH_COOKIE_NAME | Separate Preview and Production server values |

Use verified HTTPS APIs ending exactly in /api/v1, without credentials, query or fragment. Hosted loopback URLs are rejected. Rewrites are generated at build time, so changing API_INTERNAL_URL requires a rebuild.
Admin AUTH_API_ORIGIN must match the API-approved Admin origin. Supplier SUPPLIER_ORIGIN must match its exact approved browser origin. API TRUSTED_ORIGINS must cover explicitly authorized Agent/Supplier preview hosts.
Use host-only Secure cookies and same-origin requests. Do not copy production database secrets into previews or expose server values through NEXT_PUBLIC variables.
Turbo hashes the public website settings, Supplier origin and API settings; app environment files and shared deployment helpers are build inputs. Lead secrets are runtime-only and should not be bundled.

## Preview verification
Use an approved isolated API and authorized test account; no real bookings or supplier transactions.
Check API /api/v1/health/ready read-only before configuring it. Readiness is not commercial certification.
Run pnpm install --frozen-lockfile, affected type-check/lint/tests/build, node --test tools/deployment/config.test.mjs, and existing Website production checks.
Verify Website canonical/portal links, portal login/session/logout, allowed and denied routes, same-origin API traffic and safe unavailability states.
Agent search must reach authoritative recheck and correctly handle unavailable/expired quotes while booking remains disabled.
Protect private portal previews using available Vercel protection; do not protect the public Website.
Website's in-memory lead limiter is best effort. Verify an edge rule/shared enforcement before enabling lead delivery. Signing alone does not provide global rate limiting.

## Production gates and cutover
The existing deploy.yml is a manual reminder, not a deployment gate. Keep one provider-managed deployment path; do not add a competing auto-deployer.
Require repository CI, Website production checks and Portal deployment configuration through branch protection/rulesets. Separately verify Vercel's production check enforcement; GitHub branch protection alone does not prove Vercel waits for checks.
Prepare protected previews first. Do not merge this PR, promote, or reassign production aliases automatically.
Record serving deployment ID, domains, redirects and configuration. Verify the current Website content before changes. Attach each portal alias only after its dedicated app passes checks and cutover is authorized. Verify www.fbeds.com separately; domain attachment and DNS state were not established by this change.
After cutover repeat smoke checks and record the source SHA per app.
Rollback only the affected alias to its recorded previous deployment; never delete the serving project or change DNS as a troubleshooting shortcut.

## Evidence and unresolved blockers (2 October 2026)
Base main: 4a9d7eb5209d3a49d81b66da425a6cd36bc78078.
Connector discovery returned only bedbanks-system (prj_lVuB0DvJ2R8OAAEmtT1CqOi02eAI) in team_Nq9NAggwlwknWiH5chkDqACv.
READY production dpl_BndckUAyKfaUwqUdLgGktzPC5ZU5 at 4355ddedc2c1a82f9701b95644f639b1301d25b2 still holds Agent/Admin/Supplier aliases.
Failed preview dpl_5ke1nQrWGshMgc2ZJKThx1rHMtvH reports ENOENT for node_modules/.pnpm/node_modules/next. Detailed log retrieval is unavailable; this PR does not claim to fix that failure. Retrieve effective install/build/output/root settings and inspect dependency tracing on a clean remote preview.
Repository ruleset listing is empty and main is reported unprotected. Administration writes are unavailable.
Vercel connector does not expose project/environment/protection updates. No remote configuration was changed.
Shell GitHub/npm access timed out. Only relevant source files were materialized through the connector; full local installation, framework type-check/lint/build and actual Turbo cache-invalidation runs are blocked. Official Next.js docs were consulted because installed Next.js docs were unavailable.
Dependency-free portal tests: 7 PASS. Website configuration tests: 7 PASS using Node 24 type stripping with only a temporary import-extension adjustment. This does not replace the normal tsx/CI build verification.
A read-only fetch of the existing serving deployment returned HTTP 200 with the public Website title and https://www.fbeds.com canonical. Authenticated browser flows, API readiness, firewall rules and domain cutover remain unverified.

