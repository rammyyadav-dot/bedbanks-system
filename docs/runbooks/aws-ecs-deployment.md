# AWS ECS Fargate deployment and Vercel cutover (ADR 0040)

This runbook is a plan and a procedure. **Nothing in it has been run.** Do not create AWS resources, move data or change DNS without the owner's approval. Do the whole sequence in *staging* first. Never run `prisma migrate dev` or `db push`; never use the owner URL at runtime.

## Topology
```
Internet -> WAF -> public ALB (443; host rules) -> portal tasks (website, agent, admin, supplier; private subnets)
                                                      | server-side /api/v1 proxy (HTTPS)
                                                      v
                                   internal ALB (api.internal.<env>.<domain>) -> api tasks (private subnets)
                                                      |                                  |
                                              RDS PostgreSQL 16                 ElastiCache Redis (TLS)
                                              (data subnets, no internet route)
```
Egress: tasks use NAT (suppliers, ECR, Secrets Manager); S3 is a gateway endpoint. Only the database and Redis live in subnets with no internet route.

## Decisions the owner must make first
1. AWS account(s) and region (the Render blueprint used Frankfurt: `eu-central-1` is the default in the example tfvars). Separate accounts for staging and production are recommended.
2. Where the production database comes from today (Neon or other) and the cutover window. Acceptable downtime: a dump and restore needs a write freeze; logical replication or AWS DMS shortens it.
3. Domain: the public hosted zone must exist in Route 53 (or a delegation to it). Names: `www|agent|admin|supplier.<domain>` in production, `<name>.staging.<domain>` in staging.
4. Notifications, webhooks and email are not part of this change (ADR 0039).

## Procedure
**1. State backend (once, out of band).** S3 bucket (versioned, encrypted, private) and a DynamoDB lock table, then `terraform -chdir=infra/aws/terraform init -backend-config="bucket=..." -backend-config="key=fbeds/<env>.tfstate" -backend-config="region=..." -backend-config="dynamodb_table=..."`.

**2. First apply, in two phases (ECR tags are immutable, so the services need a real image).**
- Copy `envs/<env>.tfvars.example` to an untracked file and fill it in.
- Phase 1: `terraform apply -target=aws_ecr_repository.this -target=aws_iam_openid_connect_provider.github -target=aws_iam_role.github_build -target=aws_iam_role_policy.github_build -var-file=...`
- Set the GitHub environment (`staging`/`production`) variables: `AWS_REGION`, `AWS_BUILD_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN` (from outputs), and the public build settings per portal: `API_INTERNAL_URL` (= `https://api.internal.<env>.<domain>/api/v1`), `AUTH_API_ORIGIN` (= the Admin origin), `AUTH_COOKIE_NAME`, `SUPPLIER_ORIGIN`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_AGENT_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_SUPPLIER_URL`, `NEXT_PUBLIC_CONTACT_EMAIL`. None is secret. Add required reviewers to the `production` environment.
- Run the *AWS images* workflow from `main` (all apps). Note the commit SHA.
- Phase 2: `terraform apply -var-file=... -var initial_image_tag=<that SHA>`. Services start only after the secrets exist (step 3), so create them first or accept failed first starts that the circuit breaker rolls back.

**3. Secrets (set out of band; never in Terraform or the repository).** After the database exists:
`aws secretsmanager put-secret-value --secret-id fbeds-<env>/api/DATABASE_URL --secret-string "$URL"` (the `fbeds_api_login` URL, with `sslmode=require`), the same for `REDIS_URL` (`rediss://...`, from the output endpoint) and, when the booking module is enabled, `BOOKING_OPS_DATABASE_URL` (the `fbeds_booking_ops` URL; it must differ from `DATABASE_URL`) and set `booking_ops_enabled=true`.

**4. Migrate.** Run the one-off task (the subnets and security group are outputs):
`aws ecs run-task --cluster fbeds-<env> --launch-type FARGATE --task-definition fbeds-<env>-migrate --network-configuration "awsvpcConfiguration={subnets=[<private>],securityGroups=[<api sg>],assignPublicIp=DISABLED}"`, then read the log group `/fbeds/<env>/migrate`. Take an RDS snapshot first. Migrations run as the owner and are forward-only.

**5. Runtime roles and first administrator.** Follow `docs/runbooks/api-runtime-role.md`, `docs/runbooks/strict-role-rollout.md` and `docs/runbooks/api-deploy.md` steps 3 and 4 from a trusted shell that can reach the database (a short-lived SSM port-forward host that you create and delete yourself; this stack deliberately has no bastion). Re-run `ops:provision-booking-ops-role` after every release that changes its grants.

**6. Deploy and smoke test.** Run *AWS deploy* (api first, then the portals). The API's health check is `/api/v1/health/ready`. Before DNS exists, test through the public ALB's AWS name with a Host header, e.g. `curl -sk https://<alb-dns>/api/v1/health/ready -H 'Host: admin.staging.<domain>'` (this goes through Admin's proxy to the API). Check: login and logout on each portal, the Secure host-only cookie, denied routes, `/api/v1` calls stay same-origin, the redirect `Location` host after an anonymous request (Next standalone behind an ALB must use the request Host), the website demo form rate limit (`TRUSTED_PROXY=aws-alb`), CSP and HSTS headers, WAF metrics.

**7. Staging soak.** At least a week with alarms subscribed (`alarm_email`). Rehearse the database restore into staging from a production dump and record the timings.

## Cutover from Vercel (production; needs owner approval for each gate)
1. Freeze: record the serving Vercel deployments and the current DNS records. Lower DNS TTL to 60 s a day ahead.
2. Data: take a snapshot of the current database; stop writes (or start replication); dump and restore into RDS; recreate the three roles with new passwords (roles are not in a dump); run the migration task (a no-op if current); compare `_prisma_migrations` and per-table row counts; put the new URLs in Secrets Manager.
3. Deploy the production services; verify through the ALB name as in step 6 with production data read-only.
4. Set `create_portal_records=true` and apply: the four DNS records now point at AWS. Keep the Vercel projects, unaliased, for at least 14 days.
5. Watch: alarms, 5xx, login success, supplier call logs, queue depth.
**Point of no return:** once writes land in RDS, the old database is stale and cannot be merged back. Before that moment rollback is only a DNS change.

## Rollback
- A bad release: the circuit breaker already reverted a deployment that never became healthy. To revert a healthy-but-wrong release, run *AWS deploy* with the previous commit SHA (images are immutable and kept; the last 40 are retained).
- A bad cutover before the first write: restore the old DNS records (set `create_portal_records=false` and apply, or edit the records) and keep serving from Vercel.
- After writes: roll forward, or restore the RDS snapshot to a new instance and repoint the secrets, accepting loss of writes after the snapshot.

## Operating
- Alarms: unhealthy targets (each service), API 5xx, database CPU and free storage; add RDS connections and ECS memory once baselines exist.
- Rebuild and redeploy base images on a schedule (Node security updates). ECR scans on push.
- Autoscaling: CPU target tracking, minimum = desired count, maximum = 4x. Revisit after load tests.
- Costs to watch: NAT data processing (consider interface endpoints for ECR, Logs and Secrets Manager), ALBs, Multi-AZ RDS.
- Swagger is served at `/api/docs` by the API; it is reachable only from inside the VPC here. Disable it before ever exposing the API publicly.

## Express Mode previews
`infra/aws/express/create-preview-service.sh <image> <port>` creates a throwaway service with its own HTTPS endpoint. Use it for branch previews of a portal in the *staging* environment, built with staging build settings. Protect previews (no public Admin) and delete them when the branch closes. Verify the CLI options first (`aws ecs create-express-gateway-service help`).

## Known gaps and risks
- No Terraform plan, image build or ECS start has been exercised; the Terraform CI job (`terraform-check.yml`) runs `fmt`, `init -backend=false` and `validate` on pull requests, which is the first real check.
- `agent-portal` fetches Google Fonts at build time; the image build needs outbound access to Google Fonts (the CI runner has it; a fully offline build does not).
- The API starts from TypeScript source with `@swc-node/register` (unchanged from today): larger image, slower start. The health-check grace period is 120 s for that reason.
- Single region. There is no cross-region recovery; RDS snapshots can be copied cross-region if the owner wants that.

## Pre-migration readiness checklist (mapped to this repository)
| Item | State | Notes |
|---|---|---|
| Health endpoint | Built | Portals: `app/api/health/route.ts` (200 `{"status":"ok"}`, no database dependency on purpose: a database blip must not drain every portal). API: `/api/v1/health` (liveness) and `/api/v1/health/ready` (503 when the database or Redis is down); the load balancer uses the readiness one. The routes live under `app/`, not `src/app/`, in this monorepo. |
| `output: 'standalone'` | Built, env-gated | Each `next.config` enables it when `NEXT_OUTPUT=standalone` (set by `Dockerfile.web`) with `outputFileTracingRoot` at the repository root; Vercel and local builds are unchanged. The server binds `0.0.0.0` through `HOSTNAME`/`PORT`, which the Dockerfile sets. A plain `module.exports` in `next.config.js` would not apply: the configs are `.mjs`/`.ts` and the monorepo needs the tracing root. |
| Dockerfile and `.dockerignore` | Built | `Dockerfile.web` (multi-stage, non-root, one recipe for four apps) and `Dockerfile.api`; both run as `node`. Not yet built here: no Docker daemon. Use `scripts/docker-test.sh`. |
| Secrets and environment | Built | Secrets Manager shells per secret, injected through the task definition `secrets` block (ARNs come from Terraform, never hand-typed); only non-secret settings are plain `environment`. The execution role may read only this environment's runtime secrets; the database owner secret is readable only by the migration task role. |
| ECR | Built | One repository per service, immutable tags, scan on push, KMS. Created by Terraform (phase 1 apply), not by hand. |
| IAM execution role | Built | `AmazonECSTaskExecutionRolePolicy` plus scoped `GetSecretValue`/`kms:Decrypt`; CloudWatch log groups are created and KMS-encrypted. |
| Static assets via S3 and CloudFront, `assetPrefix` | **Not done, deliberately** | Admin and Agent set `images.unoptimized` and Admin's CSP is `script-src 'self'`, so a CDN `assetPrefix` would be blocked until the CSP lists the CDN origin, and the portals are authenticated apps with little static weight. The website serves no uploaded media. Revisit with measurements: add a CloudFront distribution in front of the public ALB (cache `/_next/static/*`, which is content-hashed and immutable) rather than changing `assetPrefix`; that needs no CSP change and no S3 bucket. |
| Database pooler / `@neondatabase/serverless` | **Built: bounded pools; driver not required** (see "Database connections and pooling") | That driver is for serverless and edge runtimes. The API is a long-running Prisma service on Fargate with a connection pool. What matters: (a) if the database stays on Neon, use its *pooled* (PgBouncer, transaction mode) URI for the runtime role and the *unpooled* URI for the migration task; tenant isolation sets `app.current_tenant_id` with a transaction-local `set_config`, which is safe under transaction pooling, but test it in staging; (b) on RDS (this plan) tasks connect directly: size `connection_limit` x tasks below `max_connections`, or add RDS Proxy if scaling out far. Moving off Neon is the owner's decision (runbook, "Decisions"). |
| Local verification | Built | `scripts/docker-test.sh web <app>` and `scripts/docker-test.sh api` (disposable pgvector PostgreSQL and Redis, owner-run migrate and runtime-role provisioning, boot, health and readiness probes, non-root and not-the-owner checks). It never accepts or prints a production URL. |

## Database connections and pooling
**Finding re-examined.** No Next.js route handler in this repository touches the database: Prisma is used only by the long-running NestJS API, and the portals reach it through the server-side `/api/v1` proxy. So there is no per-request serverless connection fan-out, and `@neondatabase/serverless` (a driver for serverless and edge runtimes) is not needed and would mean moving Prisma onto driver adapters for no gain. The real exposure was different: Prisma's default pool is `cpus * 2 + 1` **per client**, and in a container `cpus` is the host's core count, with three clients per task (main, booking module, hold-expiry sweeper) and several tasks. Nothing capped it, and a request waiting for a connection waited without a limit.

**Wording correction.** Prisma's default pool is finite but CPU-sized (`cpus * 2 + 1` per client), not unbounded; the risk is that it follows the *host's* cores in a container and multiplies by clients and tasks, with no wait limit.

**Dedicated clients.** Any new long-lived client built from its own URL (for example a cancellation, settlement or deadline-monitoring database) must call `withPoolSettings(url, env, { maxVar, defaultMax })`; `pool-usage.spec.ts` fails the build if one does not. Its size must be added to the Terraform budget (`db_cancellation_pool_max` is reserved at 5 for that purpose).

**What now bounds it** (`apps/api/src/database/pool-config.ts`, applied in `PrismaService`, the booking module's client and the sweeper):
| Setting | Default | Variable |
|---|---|---|
| Main client connections per task | 10 | `DB_POOL_MAX` |
| Booking module client | 5 | `DB_BOOKING_POOL_MAX` |
| Hold-expiry sweeper | 2 | `DB_SWEEPER_POOL_MAX` |
| Wait for a free connection | 10 s, then the request fails (Prisma `P2024`) | `DB_POOL_TIMEOUT_SECONDS` |
| Opening a connection | 10 s | `DB_CONNECT_TIMEOUT_SECONDS` |
| Transaction pooler in front (disables prepared statements) | off; auto-on for `-pooler.`/`pgbouncer` hosts | `DB_PGBOUNCER=true` |
A value already in the URL wins; a malformed variable stops startup. Verified against PostgreSQL: with a pool of 3, 30 concurrent callers peaked at 3 server connections, and with all 3 held a further request failed after about 1 s (`P2024`) instead of queueing.

**Connection budget.** Worst case = (main + booking + sweeper + reserved cancellation client) x maximum tasks = (10 + 5 + 2 + 5) x (2 x 4) = 176 with the defaults (the Terraform output `db_connection_budget` prints it). RDS `db.m7g.large` allows roughly 900 (`max_connections` is derived from memory), so the budget is comfortable; a smaller instance class or more tasks must be re-checked. The `db-connections` alarm fires above `db_connections_alarm_threshold` (default 400). Raise pools only with the database's limit in view: more connections rarely mean more throughput.

**Readiness under saturation.** `/api/v1/health/ready` runs `SELECT 1` through the same pool. If a pool is saturated for longer than the load balancer's three 5-second probes, tasks are taken out of rotation, which adds load to the rest. If load tests show this, give readiness its own one-connection client or relax the unhealthy threshold; do not raise the pool to hide it.

**If a pooler is added** (PgBouncer sidecar or RDS Proxy; Neon's pooled endpoint if the database stays on Neon): use the pooled URI for the runtime role (`DATABASE_URL`, `BOOKING_OPS_DATABASE_URL`) and the direct URI for migrations and role provisioning (the migration task and the owner-run steps already require it: `isPooledHost` blocks pooled endpoints there). Tenant isolation uses `set_config(..., true)`, scoped to the transaction, so it is correct under transaction pooling; no session-level setting is used and none may be added. RDS Proxy "pins" a client connection to one server connection when session state changes, which would remove its benefit: confirm in staging, with a load test that mixes search and hold writes, before relying on it. Neither pooler is deployed by this stack.
