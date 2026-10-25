# AWS ECS Fargate deployment and Vercel cutover (ADR 0040)

This runbook is a plan and a procedure. **Nothing in it has been run.** Do not create AWS resources, move data or change DNS without the owner's approval. Do the whole sequence in *staging* first. Never run `prisma migrate dev` or `db push`; never use the owner URL at runtime.

## Topology
```
Internet -> [CloudFront + CLOUDFRONT WAF, when cloudfront_enabled] -> public ALB + regional WAF (443; host rules; with CloudFront it
            admits only the CloudFront prefix list AND the X-Origin-Verify header) -> portal tasks (website, agent, admin, supplier; private subnets)
                                                      | server-side /api/v1 proxy (HTTPS)
                                                      v
                                   internal ALB (api.internal.<env>.<domain>) -> api tasks (private subnets)
                                                      |                                  |
                                              RDS PostgreSQL 16                 ElastiCache Redis (TLS)
                                              (data subnets, no internet route)
```
Egress: tasks use NAT (suppliers, ECR, Secrets Manager); S3 is a gateway endpoint. Only the database and Redis live in subnets with no internet route.

## Decisions the owner must make first
1. AWS account(s) and region. **Region is `ap-south-1` (ADR 0055).** Separate accounts for staging and production are recommended. Staging must be access-restricted (`public_ingress_cidrs`); production needs CloudFront or an approved exception (`production_edge_exception_ref`) and `dns_cutover_authorization_ref` before any public record. Audit the account first (`docs/aws-account-security-checklist.md`) and work through `docs/aws-staging-readiness-checklist.md`.
2. Where the production database comes from today (Neon or other) and the cutover window. Acceptable downtime: a dump and restore needs a write freeze; logical replication or AWS DMS shortens it.
3. Domain: the public hosted zone must exist in Route 53 (or a delegation to it). Names: `www|agent|admin|supplier.<domain>` in production, `<name>.staging.<domain>` in staging.
4. Notifications, webhooks and email are not part of this change (ADR 0039).

## Procedure
**1. State backend (once, out of band).** S3 bucket (versioned, encrypted, private) and a DynamoDB lock table, then `terraform -chdir=infra/aws/terraform init -backend-config="bucket=..." -backend-config="key=fbeds/<env>.tfstate" -backend-config="region=..." -backend-config="dynamodb_table=..."`.

**2. First apply, in two phases (ECR tags are immutable, so the services need a real image).**
- Copy `envs/<env>.tfvars.example` to an untracked file and fill it in.
- Phase 1: `terraform apply -target=aws_ecr_repository.this -target=aws_iam_openid_connect_provider.github -target=aws_iam_role.github_build -target=aws_iam_role_policy.github_build -var-file=...`
- Set the GitHub environment (`staging`/`production`) variables: `AWS_REGION`, `AWS_BUILD_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN` (from outputs), and the **website-only** public build settings `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_AGENT_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_SUPPLIER_URL`, `NEXT_PUBLIC_CONTACT_EMAIL` (canonical URLs; none is secret). Agent, Admin, Supplier and API images take no environment settings at build time (ADR 0056): `API_INTERNAL_URL`, `AUTH_API_ORIGIN`, `SUPPLIER_ORIGIN` and `AUTH_COOKIE_NAME` are runtime values in the task definitions (`ecs.tf`). Add required reviewers to the `production` environment.
- Run the *AWS images* workflow from `main` (all apps). Note the commit SHA.
- Phase 2: `terraform apply -var-file=... -var initial_image_tag=<that SHA>`. Services start only after the secrets exist (step 3), so create them first or accept failed first starts that the circuit breaker rolls back.

**3. Secrets.** `REDIS_URL` is created by Terraform (the AUTH token is generated there and lands in the encrypted state: `docs/aws-secret-rotation-runbook.md`); nothing to do. Database credentials are set out of band and never in Terraform or the repository. After the database exists:
`aws secretsmanager put-secret-value --secret-id fbeds-<env>/api/DATABASE_URL --secret-string "$URL"` (the `fbeds_api_login` URL, with `sslmode=require`), and, when the booking module is enabled, `BOOKING_OPS_DATABASE_URL` (the `fbeds_booking_ops` URL; it must differ from `DATABASE_URL`) and set `booking_ops_enabled=true`.

**4. Migrate.** Take an RDS snapshot, then from your own (owner) AWS credentials run `scripts/ecs-migrate.sh <env> <commit sha>` (add `--dry-run` first). It registers a migrate task definition revision pinned to the digest of `fbeds/api:<sha>-migrate`, runs it in the api service's subnets and security group, and fails unless the task exits 0; read the log group `/fbeds/<env>/migrate`. **Do not run the Terraform-created `fbeds-<env>-migrate` family directly:** it is pinned to `initial_image_tag` and would re-apply the first release's migrations and nothing newer. Migrations run as the owner and are forward-only. CI cannot do this step by design (ADR 0040, 0055, 0090).

**5. Runtime roles and first administrator.** Follow `docs/runbooks/api-runtime-role.md`, `docs/runbooks/strict-role-rollout.md` and `docs/runbooks/api-deploy.md` steps 3 and 4 from a trusted shell that can reach the database (a short-lived SSM port-forward host that you create and delete yourself; this stack deliberately has no bastion). Re-run `ops:provision-booking-ops-role` after every release that changes its grants.

**6. Deploy and smoke test.** With `STAGING_PIPELINE_ENABLED=true` the *Staging release* workflow builds and deploys every migration-free commit that passes CI on main, and holds the deploy (with the exact commands in its summary) when migrations changed; otherwise run *AWS deploy* (api first, then the portals). The API's health check is `/api/v1/health/ready`. Before DNS exists, test through the public ALB's AWS name with a Host header, e.g. `curl -sk https://<alb-dns>/api/v1/health/ready -H 'Host: admin.staging.<domain>'` (this goes through Admin's proxy to the API). Check: login and logout on each portal, the Secure host-only cookie, denied routes, `/api/v1` calls stay same-origin, the redirect `Location` host after an anonymous request (Next standalone behind an ALB must use the request Host), the website demo form rate limit (`TRUSTED_PROXY=aws-alb`, or `aws-cloudfront-alb` when the edge is enabled: confirm two requests from different networks get different buckets), CSP and HSTS headers, WAF metrics and that the WAF/ALB/flow/RDS logs are arriving.

**6b. Edge checks (only with `cloudfront_enabled = true`; the CloudFront default domain does not serve the portal hosts, so pin the alias to an edge address).** `curl --resolve agent.staging.<domain>:443:$(dig +short <dxxxx>.cloudfront.net | head -1) https://agent.staging.<domain>/login`. Then prove the bypass fails: the same request straight to the ALB name must return 404/403 (no `X-Origin-Verify`), and a request from outside `public_ingress_cidrs` must be blocked at the edge (staging). Confirm `/api/v1/...` and `/login` responses are never served from cache (`X-Cache: Miss from cloudfront` or `Error`, never `Hit`), `/_next/static/*` is, `http://` redirects to `https://`, and the HSTS/nosniff headers are present on Agent and Supplier.

**6c. One image, two environments (portals).** Agent, Admin and Supplier images are environment-neutral. Promote by digest: build once (staging), copy the same digest to the production registry (ECR replication or `docker buildx imagetools create`), and check that the production task definition references the same `sha256:` as staging. Do not rebuild.

**7. Staging soak.** At least a week with alarms subscribed (`alarm_email`). Rehearse the database restore into staging from a production dump and record the timings.

## Cutover from Vercel (production; needs owner approval for each gate)
1. Freeze: record the serving Vercel deployments and the current DNS records. Lower DNS TTL to 60 s a day ahead.
2. Data (ADR 0079: RDS is the primary; Neon is the source until the switch). Start days ahead, in staging first:
   - Neon: `scripts/neon-staging-branch.sh protect`, then `restore-point`; enable logical replication on the Neon project (it cannot be disabled afterwards), create a publication for the application tables with a dedicated replication role.
   - RDS: apply migrations to an empty `fbeds` with the migrate task *at the same commit as Neon's `_prisma_migrations`* (schema must match; logical replication copies rows, not DDL, sequences, roles or grants). Create the subscription from the private subnets (short-lived SSM host, step 5), with `sslmode=require`. Neon must admit the NAT gateway addresses (allowlist, paid plan).
   - Watch lag to zero; compare `_prisma_migrations` and per-table row counts and checksums; rebuild no indexes by hand (the migrations already created the vector and trigram indexes).
   - Freeze window: stop writes to Neon (maintenance mode on the API), wait for lag zero, take an RDS snapshot, copy sequence values to RDS (`setval` to Neon's `last_value` plus a safety margin), drop the subscription, recreate the three runtime roles with new passwords and re-run the role provisioning, put the RDS URLs in Secrets Manager.
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
- Budget: `monthly_budget_usd` + `budget_emails` create an AWS Budget (alerts at 80% and 100% actual, 100% forecast). Activate the `Environment`, `Owner` and `CostCenter` cost-allocation tags once in Billing first, or the tag filter reports nothing.
- Costs to watch: NAT data processing (consider interface endpoints for ECR, Logs and Secrets Manager), ALBs, Multi-AZ RDS.
- Swagger is served at `/api/docs` by the API; it is reachable only from inside the VPC here. Disable it before ever exposing the API publicly.

## Express Mode previews
`infra/aws/express/create-preview-service.sh <image> <port>` creates a throwaway service with its own HTTPS endpoint. Use it for branch previews of a portal in the *staging* environment, built with staging build settings. Protect previews (no public Admin) and delete them when the branch closes. Verify the CLI options first (`aws ecs create-express-gateway-service help`).

## Known gaps and risks
- Nothing here has been planned, applied or started in an AWS account. The mock-provider `terraform test`, checkov, tflint, actionlint and the governance mutation tests are the offline checks; a reviewed real `terraform plan` is still required before any apply.
- The website still bakes public canonical URLs at build time, so its image serves one environment (ADR 0056). Agent, Admin, Supplier and API are promotable by digest; the cross-account copy step is a procedure, not automation.
- CloudFront standard access logging is not configured (ALB and edge WAF logs cover the traffic for now); VPC Origins would remove the public ALB and is recommended once proven in staging.
- The Redis AUTH token and the origin-verify secrets are in the encrypted Terraform state. Rotation is manual (`docs/aws-secret-rotation-runbook.md`) and has not been drilled.
- `agent-portal` fetches Google Fonts at build time; the image build needs outbound access to Google Fonts (the CI runner has it; a fully offline build does not; a TLS-inspecting proxy needs `NODE_EXTRA_CA_CERTS` and bypasses Turbo's strict environment).
- The API starts from TypeScript source with `@swc-node/register` (unchanged from today): larger image, slower start. The health-check grace period is 120 s for that reason.
- Single region. There is no cross-region recovery; RDS snapshots can be copied cross-region if the owner wants that.
