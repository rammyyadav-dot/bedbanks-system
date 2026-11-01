# AWS secret inventory, state exposure and rotation (WP3 3.6)

Nothing here has been executed against AWS. Procedures are written for staging first; each needs the owner's go-ahead because they change credentials.

## Inventory: where each secret lives and who can read it
| Secret | Created by | Stored in | Value in Terraform state? | Readers | Rotation |
|---|---|---|---|---|---|
| RDS owner (`fbeds_owner`) password | RDS (`manage_master_user_password`) | Secrets Manager (RDS-managed, KMS `data` key) | **No**, only the secret ARN | `migrate_execution` role only (`iam.tf`); humans via audited break-glass | **Automatic, managed by RDS** (verify: `aws secretsmanager describe-secret` shows `RotationEnabled`; the schedule is RDS's, not ours) |
| `DATABASE_URL` (`fbeds_api_login`) | operator, out of band (`ops:provision-api-runtime-role`) | Secrets Manager shell `…/api/DATABASE_URL` | **No**: Terraform creates an empty shell | ECS execution role (this environment's three secrets only) | **Manual** (below) |
| `BOOKING_OPS_DATABASE_URL` | operator, out of band | shell `…/api/BOOKING_OPS_DATABASE_URL` | **No** | same | **Manual** (below) |
| `REDIS_URL` (cache AUTH token inside) | Terraform (`random_password.redis_auth`) | Secrets Manager `…/api/REDIS_URL` | **Yes**: token and the URL | same | **Manual, rolling** (below) |
| CloudFront origin-verify secrets `a`/`b` | Terraform (`random_password.origin_verify`) | CloudFront origin custom header and ALB listener-rule condition | **Yes**; also visible to anyone who can describe the distribution or listener rules | AWS principals with CloudFront/ELB read | **Manual, zero-gap** (below) |
| GitHub → AWS | OIDC | none (no long-lived keys; guarded by CI) | n/a | n/a | n/a |

**Secret reference vs secret material.** A reference is an ARN or name (`secret_arns` output, the `valueFrom` in task definitions): safe in state, outputs and logs. Material is a token or password: it exists in state only for the two Terraform-generated rows above, and `pnpm check:aws-governance` fails if any other generated secret, any other `aws_secretsmanager_secret_version`, or any output that touches secret material appears.

**The state therefore is a secret store for those rows.** The backend bucket must have SSE-KMS, versioning, public access blocked, a TLS-only policy, and read access limited to the apply role (`docs/aws-account-security-checklist.md` rows 7 to 9; checked by `infra/aws/audit/account-audit.sh`). `terraform show` and `terraform plan` output are sensitive: do not paste them into tickets or CI logs. Redis is a search cache, not the ledger; the origin-verify secret is one layer of four (`edge.tf`); that is why accepting them in state is proportionate. Database credentials are deliberately never in state.

**Where secrets must never appear:** Terraform outputs (CI-enforced), GitHub Actions logs (the workflows pass no secrets; build args are public, non-secret values only), container images (`.dockerignore` excludes `.env*`; the governance check blocks API/auth build args in `Dockerfile.web`), task definitions' plain `environment` (secrets use `secrets[].valueFrom`).

## Why not automatic rotation for the runtime database URLs
Rotating `fbeds_api_login` means changing a PostgreSQL role password, rewriting the URL secret and restarting tasks in one coordinated step, without ever granting more than the strict role has (ADR 0008/0040; "never broaden grants to make something work"). A generic AWS rotation function assumes it may run as an administrator against the database, which is the opposite of our boundary. Until a purpose-built, least-privilege rotation function is designed and drilled in staging, rotation is a documented manual procedure. Checkov `CKV2_AWS_57` stays on the OPEN list.

## Procedures (staging first)
### A. Runtime database login (`DATABASE_URL`, `BOOKING_OPS_DATABASE_URL`)
1. From a trusted shell that can reach the database (short-lived SSM port-forward, as in the deployment runbook), run the existing provisioning command with a new password: see `docs/runbooks/api-runtime-role.md` (and `docs/runbooks/rate-plan-ops-role-certification.md` for the other roles). Never use the owner URL at runtime.
2. `aws secretsmanager put-secret-value --secret-id fbeds-<env>/api/DATABASE_URL --secret-string "$URL"` (`sslmode=require`; the booking URL must differ from `DATABASE_URL`).
3. Roll the API so tasks read the new value (ECS injects secrets at task start): redeploy the same digest with *AWS deploy* (api only).
4. Verify `/api/v1/health/ready` and that the API's boot identity guard accepted the login (no superuser, no BYPASSRLS, owns nothing).
5. Rollback is fix-forward: the provisioning command replaces the role password, so the previous URL is already invalid and `AWSPREVIOUS` cannot be restored. If step 3 or 4 fails, run step 1 again with another new password, put that value, and redeploy.
6. Record date and operator. Suggested interval: 90 days, and immediately on suspected exposure.

### B. Redis AUTH token (`REDIS_URL`)
1. Change `redis_auth_rotation_id` (any new string) and keep `redis_auth_update_strategy = "ROTATE"`; plan; **a human reviews the plan**; apply. ElastiCache now accepts the new and the previous token; Terraform writes the new `REDIS_URL` version.
2. Redeploy the API (same digest) so tasks pick up the new URL; verify cache hits and no AUTH errors in the API logs.
3. Purge the previous token: set `redis_auth_update_strategy = "SET"` and apply once; set it back to `ROTATE`.
4. A failure in step 2 is safe to roll back while step 3 has not run: put the previous `REDIS_URL` version back (`AWSPREVIOUS`).

### C. CloudFront origin-verify secret (zero gap; only when `cloudfront_enabled`)
The ALB accepts **both** slots at all times; CloudFront sends only the active slot.
1. Increment `origin_verify_rotation_id["b"]` (the inactive slot, if `a` is active) and apply: slot `b` has a new value; CloudFront still sends `a`.
2. Set `origin_verify_active_slot = "b"` and apply; wait for the CloudFront deployment to finish (`aws cloudfront get-distribution` shows `Deployed`), then confirm the site answers through CloudFront.
3. Increment `origin_verify_rotation_id["a"]` to retire the old value. Direct requests to the ALB must return 404 throughout (test with `curl -k https://<alb-dns>/ -H 'Host: <portal host>'`).

### D. RDS owner password
Managed by RDS. Confirm rotation is enabled and note the next date. Only the migrate task role can read it. Never copy it into another secret or a runner.

## Drill
Before production, rehearse A, B and C in staging, record the time taken and any dropped requests, and attach the notes to `docs/aws-wp3-verification-evidence.md`. **Not yet performed.**
