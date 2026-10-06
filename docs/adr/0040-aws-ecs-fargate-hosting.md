# ADR 0040: Host on AWS ECS Fargate instead of Vercel

Status: proposed (nothing has been deployed or cut over by this change). Owner approval needed before any AWS resource is created and before any DNS or data move.

## Context
Today the four Next.js apps (website, agent, admin, supplier) run on Vercel, the API is meant for a container host (Render blueprint, Neon), and `docs/runbooks/vercel-deployment-topology.md` records that the Vercel path is unproven (failed preview, project not discoverable, no branch protection). The API is a long-running NestJS process with a PostgreSQL 16 database (pgvector, pg_trgm, forced row-level security, three database roles) and Redis. We want one provider, one network, and no public database path.

## Decision
1. **Everything runs as containers on ECS Fargate in one VPC**: five services (`api`, `admin`, `agent`, `supplier`, `website`), images in ECR with immutable SHA tags, RDS PostgreSQL 16 (Multi-AZ in production), ElastiCache Redis with TLS, Secrets Manager, CloudWatch.
2. **The API is not public.** Browsers only call their own portal; each portal proxies `/api/v1/*` server-side (the existing same-origin rewrite, ADR 0010). So the API sits behind an *internal* ALB with a private DNS name (`api.internal.<env>.<domain>`, public ACM certificate) and a security group that admits only the portals. This removes the API from the internet and keeps the session cookie host-only on each portal origin, exactly as today. If a supplier webhook ever needs inbound access, add a narrowly routed public listener then, with its own WAF rule set.
3. **Terraform for production and staging; ECS Express Mode for previews.** Express Mode builds an ALB, target group, security groups and scaling from an image and two roles, which is ideal for a throwaway per-branch portal. We do not use it for production because production needs things we must control explicitly: a private API load balancer, WAF, custom domains, secret injection, a migration task and exact IAM. `infra/aws/express/create-preview-service.sh` wraps the one documented command; its options must be verified against the current CLI before use (the docs were not reachable from the build environment).
4. **Same image, one environment.** Next.js bakes the `/api/v1` rewrite at build time, so each portal image is built for one environment (`Dockerfile.web` build args, non-secret only) and promoted only inside it. The API image is environment-neutral (all configuration is runtime).
5. **CI builds, a person deploys.** `aws-images.yml` builds and pushes (OIDC role assumable only from `main`); `aws-deploy.yml` rolls named services to a given commit, behind GitHub environment reviewers, one service at a time with a stability check that also detects a circuit-breaker rollback. Neither runs migrations. Migrations remain the owner-run one-off ECS task (`fbeds-<env>-migrate`), which is the only principal allowed to read the database owner secret.
6. **Runtime database roles are unchanged and still owner-provisioned.** `DATABASE_URL` is the strict `fbeds_api_login` URL and `BOOKING_OPS_DATABASE_URL` the `fbeds_booking_ops` URL, both in Secrets Manager; the owner password exists only in the RDS-managed secret. Terraform never holds a secret value.

## Vercel behaviours replaced
| Vercel | AWS |
|---|---|
| Edge TLS and aliases | ACM + public ALB (host-based rules) + Route 53; records created only at cutover (`create_portal_records`) |
| Firewall and bot rules | WAFv2 on the public ALB: managed common and bad-input rule sets, per-IP rate limit |
| `VERCEL=1` hosted validation of `API_INTERNAL_URL` | `PORTAL_HOSTED=1` (set by `Dockerfile.web`) enforces the same rules: HTTPS, non-loopback, exact `/api/v1` |
| `x-vercel-forwarded-for` for the lead rate limiter | `TRUSTED_PROXY=aws-alb`: only the last `X-Forwarded-For` entry (the one the ALB appends) is trusted; the Vercel and `x-real-ip` headers are ignored because nothing strips them on AWS and a client could set them |
| Preview deployments | Express Mode services per branch (staging account or environment), protected |
| Logs and analytics | CloudWatch log groups per service (KMS, 30/90 days retention), Container Insights, alarms to SNS |
| Build cache (Turbo) | Docker layer cache in the build job; Turbo env hashing unchanged (`PORTAL_HOSTED`, `NEXT_OUTPUT` added to the build env list) |

## Consequences
- Fixed monthly cost replaces per-deployment pricing: NAT gateways, two ALBs, RDS Multi-AZ, ElastiCache. Staging uses one NAT, single-AZ database and one task per service.
- We operate patching of the Node base image (rebuild on a schedule), capacity and alarms.
- The container start command of the API still uses `@swc-node/register` on source (as today); a compiled `dist` start is a follow-up that needs its own verification.
- The database must be moved from its current provider (see the runbook). That is a data migration with a point of no return and needs explicit approval.

## Not done here (unverified)
No AWS API call, Docker daemon, or Terraform binary was available while writing this. Verified: HCL parses; the four-line `PORTAL_HOSTED` rules pass the existing deployment tests plus a new one; the admin app builds as a standalone server from the repository layout and serves `/login` (200), redirects an anonymous `/` to `/login`, and sends its CSP and HSTS headers; the lead-address function has unit tests. Not verified: `terraform validate/plan/apply`, image builds, ECS task start, ALB health checks, the Express Mode command options, standalone redirect host behaviour behind an ALB.
