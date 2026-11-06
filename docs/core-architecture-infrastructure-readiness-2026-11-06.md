# Core architecture and infrastructure readiness — 6 November 2026

This review checks the reported “92% complete, on track” status against the repository and the public surface of `fbeds.com`. It does not deploy, change DNS, open a database, or print a secret.

**Verdict: the evidence does not support 92% completion or an on-track production status.** The latest written release certification (`docs/release-certification-2026-11-02.md`) is **NO-GO**. This review did not invent the missing 8%.

Checked at 06:05 IST on 6 November 2026. Repository `main` was `22c68890`. The newest Vercel production record seen was a canceled deploy of its parent `32c17ee0` (05:51 IST). Re-run the public classification with `node tools/core-infra-readiness.mjs`. Repeat only the DNS queries with `node tools/core-infra-readiness.mjs --probe`.

## Executive status

The monorepo has a real NestJS API, four Next.js apps, shared contracts, a pinned local Docker Compose file, Terraform for AWS ECS, and Neon migration tooling. Those pieces are source-complete for a controlled platform. They are not a live global bedbank.

What is answering on the public internet today:

- `fbeds.com` is a Rediff “Site Under Construction” page at `119.252.154.32` (`host-119-252-154-32.rediffdns.com`, AS38224, Mumbai).
- `www.fbeds.com` CNAMEs to Vercel and returns **HTTP 404** `DEPLOYMENT_NOT_FOUND`.
- `agent`, `admin`, `supplier`, and `api.fbeds.com` are **NXDOMAIN**.
- The connected Vercel team has one project, `bedbanks-system` (`prj_lVuB0DvJ2R8OAAEmtT1CqOi02eAI`). Its aliases `fbeds-agent.vercel.app`, `fbeds-admin.vercel.app`, and `fbeds-hotel-supplier.vercel.app` all return the marketing page titled “fabbeds | The World's Wholesale Marketplace” with canonical `https://www.fabbeds.io`.
- Newer production deployments after `b909c8f9` are **CANCELED**. The latest canceled deployment (`dpl_D78zEM6nNRcfjAAHJdx8xH46AHkC`, commit `32c17ee0`, 05:51 IST) points at Vercel’s “skipping unaffected projects” document. `live` on the project is false.
- Hostinger does not appear in DNS, HTTP, or the infrastructure code. Cloudflare is not the authoritative DNS and did not proxy the responses (no `cf-ray`).
- AWS ECS and RDS exist as Terraform and runbooks. ADR 0040, ADR 0055, and `docs/aws-verification-evidence.md` still say nothing has been applied.
- Neon is the documented database until the RDS cutover (ADR 0079). This review did not connect to Neon. The production checklist in `docs/postgres-production-release-checklist.md` is unsigned.
- Booking stays fail-closed. The 2 November 2026 certification left hybrid search over its 200 ms budget.

## Who hosts what

| Role | Provider | Evidence class |
| --- | --- | --- |
| Authoritative DNS | Rediff Mail Pro (`ns.rediffmailpro.com`, `ns2.rediffmailpro.com`) | Verified, public DNS |
| Apex website | Rediff shared hosting, Mumbai | Verified, HTTP 200 placeholder |
| `www` | CNAME to Vercel; hostname has no deployment | Verified, HTTP 404 |
| Portal names on `fbeds.com` | Not delegated | Verified, NXDOMAIN |
| Marketing and the three `*.vercel.app` aliases | One Vercel project, one marketing response | Verified, HTTP 200 and Vercel API |
| API | No public name. Render blueprint is `autoDeploy: false`. AWS is the target and is not applied | Render and AWS: repository only. Live API: needs access |
| Database | Neon until cutover, then RDS in `ap-south-1` | ADR 0079. Live connection: needs access |
| Hostinger | No role found | Verified absence |
| Cloudflare | Not DNS, not proxy | Verified absence. DNS-over-HTTPS to `cloudflare-dns.com` was only the lookup tool |
| Edge and WAF | Designed as CloudFront plus WAFv2, required before a production apply | Repository. Not deployed |

Do not treat Hostinger and AWS as two halves of the current platform. AWS is the accepted future compute and database platform. Hostinger is not in the design.

## Component review

| Component | Reported | Verification | Gap | Next action |
| --- | --- | --- | --- | --- |
| Application architecture | Stable | Monorepo boundaries, contracts, opaque sessions, tenant filters, and fail-closed supplier and booking paths are in the tree. Architecture checks are the release gate. Not re-run as a full `pnpm check:architecture` in this turn | One Vercel project serves the marketing app on Agent, Admin, and Supplier aliases. Public custom domains do not reach it | Split the four apps into the projects named in `docs/runbooks/vercel-deployment-topology.md` before any alias cutover. Acceptance: each hostname returns its own app, and Agent search stays unavailable when the supplier is unconfigured |
| API contracts and errors | Stable | `@bedbanks/contracts` is required before a UI calls a route. Health separates liveness (`/api/v1/health`) from readiness (`/api/v1/health/ready`, 503 while draining or the database is down) | Readiness was not called on a hosted API. No `api.fbeds.com` | Record a hosted `GET /api/v1/health/ready` from the strict runtime role. Acceptance: 200 with `readiness: ready`, or an honest 503 |
| Authentication boundaries | Stable | Server sessions, HttpOnly cookies, permission checks, and RLS are the design and have prior security-suite evidence (28/28 on 2 November, not re-run here) | Hosted sign-in was not exercised. Portal aliases are the marketing site, so there is no login boundary on those URLs | Acceptance: one synthetic user signs in and out on each portal origin; a cross-tenant read is denied; the cookie is Secure and host-only |
| Docker, local | Stable for dependencies | `docker-compose.yml` pins Postgres 16 and Redis 7, binds `127.0.0.1`, and defines health checks. It does not run the apps | This environment did not start Compose | `docker compose up -d --wait` then the local setup in `docs/LOCAL_SETUP.md`. Acceptance: both health checks pass and the URLs stay on loopback |
| Docker, production images | Designed | `apps/api/Dockerfile` builds compiled `dist/main.js`, drops npm, runs as `node`, and keeps migrations in a separate target. `Dockerfile.web` does the same for Next standalone and sets `PORTAL_HOSTED=1` | Images were not built or scanned here. The 2 November cert marks Trivy **NOT VERIFIED** | Build both images from a clean tree and scan them. Acceptance: API image has no package manager and starts only `node dist/main.js`; the web image is environment-neutral for Agent, Admin, and Supplier |
| Cloudflare DNS and TLS | Reported stable | Public DNS is Rediff. Responses have no `cf-ray`. TLS on `www` is Vercel’s, and the certificate serves a 404 | Cloudflare is not in this path. Proxy, origin lock, and authenticated-origin pull are not configured | Either remove Cloudflare from the status report or put it in front of a real origin with a written lock. Acceptance: a direct-to-origin request without the origin secret fails, and HTTPS redirects from HTTP |
| Hostinger | Reported in scope | No DNS, HTTP, or repository evidence | There is nothing to harden on Hostinger | Name the account only if one exists, then record what it serves. Until then the status line should not list it |
| AWS | Reported stable | Terraform, OIDC workflows, alarms, rollback workflow, and `tools/aws-golive-preflight.mjs` refuse an early production apply. Region `ap-south-1`. API is private behind the portals | No account audit, plan, or apply. Production DNS records default off. CloudFront is still required or explicitly excepted | Owner runs the account audit and a staging plan. Acceptance: plan shows private RDS and Redis, no `0.0.0.0/0` on staging, booking off, and no production DNS records |
| Neon PostgreSQL | Reported stable | Direct versus pooled use is specified: pooled for the app, direct for migrations, `sslmode=require` off localhost. Runtime role must not be the owner. Staging branch workflow refuses production hosts | No connection was opened. Owner checklist is pending. Search budget was failed on loopback, not on a Neon pooler | Owner signs `docs/postgres-production-release-checklist.md` with backup id, role proof, and pool proof. Acceptance: runtime login is not superuser, has no `BYPASSRLS`, owns nothing, and uses the pooled host |
| CI/CD | Present | GitHub workflows build images, can deploy ECS, and keep migrations owner-run. Vercel builds are skipping newer `main` commits as unaffected | The serving Vercel production deployment can lag `main`. ECS deploy has not run | Acceptance: the production alias SHA equals the intended `main` SHA, or the skip is an explicit, reviewed ignore rule. An ECS staging deploy of that SHA reaches steady state |
| Logging, alarms, recovery | Designed | Runbooks exist for incident, recovery, and rollback. CloudWatch alarms are in Terraform and guarded by `tools/aws-governance-check.mjs` | SNS delivery, a restore onto a new instance, and an executed rollback are open from the 2 November cert | Page a test alarm, restore a snapshot to a new instance, and run the rollback workflow in staging. Acceptance: the mailbox receives the alarm, restore timing is written under `docs/evidence`, and the service is stable on the previous digest |

## Prioritized completion checklist

Severity is the effect on a production claim. Effort is the size of the change, not a calendar estimate. “Owner” means the person who already holds that access.

| Pri | Item | Severity | Depends on | Owner | Effort | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Stop reporting Hostinger, Cloudflare, and “92% on track” until the rows above are met | High | None | Product owner | Status text only | The status names Rediff DNS, the Vercel 404, and the NO-GO cert |
| 2 | Attach `www.fbeds.com` only after a Ready deployment of `apps/website`, or remove the CNAME | High | Vercel project access and DNS access at Rediff | Web owner and DNS owner | One reviewed change | `https://www.fbeds.com` returns 200 with the website canonical, HSTS, and `nosniff`. A deployment id is recorded |
| 3 | Give Agent, Admin, and Supplier their own Vercel projects and stop serving the marketing app on their aliases | High | Item 2’s project inventory | Portal owner | Four project settings, no schema change | Each alias title and canonical match that app. Anonymous admin routes redirect to login |
| 4 | Publish `agent`, `admin`, and `supplier` names only when those projects pass item 3 | High | Item 3 | DNS owner | DNS records | Each name resolves to its own app. `api.fbeds.com` stays unpublished; browsers call `/api/v1` on the portal |
| 5 | Identify the running API and prove readiness | High | The secret store for that host | API owner | Read-only probe | `GET /api/v1/health/ready` is 200 from the strict role, or the API is documented as not deployed |
| 6 | Sign the Postgres checklist for the real database | High | Owner URL, not pasted into git | Database owner | Read-only queries plus one restore drill | Checklist rows filled with references, not connection strings. Restore of a backup is recorded |
| 7 | Re-measure hybrid search on the pooled strict role | High | Item 6 and a 100k corpus | API owner | Load run already scripted | p95 and p99 under 200 ms, zero errors, EXPLAIN archived |
| 8 | Confirm or replace the Vercel ignore rule that canceled newer production builds | Medium | Vercel project settings | Release owner | Dashboard read, then a one-line ignore change if it is wrong | A later `main` SHA reaches Ready, or the skip reason is written down and matches the intended rule |
| 9 | Staging AWS plan, alarm delivery, snapshot restore, rollback | Medium | AWS account, state backend, hosted zone | Platform owner | Existing runbooks | `tools/aws-golive-preflight.mjs` passes the real tfvars, then the three drills in `docs/runbooks/aws-ecs-deployment.md` are recorded |
| 10 | Leave booking, payments, and the first live supplier off | High | Written owner authorization after items 5–7 | Product owner | No code until the decision | `BOOKING_ENABLED` stays false. A supplier adapter ships only with an approved spec and a secret-manager reference |

Items 2–4 change public DNS and Vercel. They were not done in this change, because the current CNAME already points at a missing deployment and a wrong cutover would make that worse.

## Deployment and rollback validation

Use this before any production promotion. A box is done only with a recorded id, SHA, or ticket. This review completed none of the live rows.

- [ ] Record the serving Vercel deployment id, SHA, and the four hostnames before changing anything.
- [ ] Record the Rediff zone as it is: apex A `119.252.154.32`, `www` CNAME, MX to Rediff, no portal names.
- [ ] Confirm the API image digest and the portal image digests. Agent, Admin, and Supplier must be promoted by digest, not rebuilt (ADR 0056).
- [ ] Run migrations as the owner on a direct, TLS connection. The runtime task must not receive that URL.
- [ ] Deploy the API first. `GET /api/v1/health` stays 200. `GET /api/v1/health/ready` is 200 before portals send traffic.
- [ ] Deploy one portal at a time. Anonymous `/` on Admin and Supplier redirects to login. `/api/v1` stays same-origin.
- [ ] Abort if, for five consecutive minutes, API 5xx exceeds 20, API p95 exceeds 750 ms, healthy hosts are zero, or RDS CPU stays over 80% while errors rise (`docs/runbooks/rollback.md`).
- [ ] Roll back application code with the AWS rollback workflow or Vercel’s previous deployment. Do not roll the API back across a migration it cannot run.
- [ ] After rollback, within the five-minute target: both health routes are 200, one synthetic sign-in works, a fixture search returns contracted offers, and `prisma migrate status` still matches the chain.
- [ ] DNS rollback, before the first write on a new database, is restoring the previous records. After that write, roll forward or restore the snapshot and accept the lost writes.

## Readiness assessment

| Claim | Supported? |
| --- | --- |
| NestJS and Next.js applications exist and are the system of record in git | Yes |
| Docker, Neon tooling, AWS Terraform, health checks, and rollback runbooks exist | Yes, as source and procedures |
| Cloudflare DNS, Hostinger hosting, and a stable public production path | No |
| AWS and Neon are operating as the production platform | Not shown. AWS apply is explicitly unverified. Neon was not contacted |
| A functioning global bedbank (live search, book, cancel, settle) | No. Booking is fail-closed and no live supplier adapter is certified |
| 92% complete and on track | No. The claim has no measurement in the repository, and the public site plus the 2 November NO-GO contradict it |

`node --test tools/core-infra-readiness.test.mjs` locks this classification. A future observation supports the reported status only when the blocking checks in `assess()` all pass together: the public site, separate portals, an AWS apply record, a signed database checklist, the search budget, and a named booking certification.
