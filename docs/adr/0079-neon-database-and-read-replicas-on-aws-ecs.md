# ADR 0079: Database provider for the AWS ECS production cutover, and Neon read replicas

Status: **accepted 2026-10-22 on the owner's instruction to follow the recommendation: Option A (RDS is the production primary).** Nothing is provisioned by this ADR; every production gate in ADR 0055 still applies.

## Context
ADR 0040 and ADR 0055 provision **RDS PostgreSQL 16 (Multi-AZ)** inside the VPC (`data.tf`, private data subnets, no internet route). Production data today lives in **Neon** (ADR 0075: protected `main` branch, PITR window, governed `staging` branch). The ECS runbook already lists "where the production database comes from today" as an open owner decision, and the cutover section assumes a dump and restore into RDS, with a write freeze and a point of no return.

The request to provision "Neon production replicas" alongside ECS conflicts with that plan: RDS and Neon are two different answers to the same question.

## Options
| | A. RDS (as built) | B. Keep Neon as the system of record, ECS for compute |
|---|---|---|
| Database path | private subnets, no public route | public Neon endpoint over TLS from NAT egress; Neon IP allowlist (paid plan) restricted to the NAT gateway EIPs |
| Data move at cutover | dump/restore or DMS, write freeze, point of no return | none: ECS tasks get a new `DATABASE_URL`; DNS rollback stays a real rollback because the database is shared |
| Rollback | DNS only before first write, then roll forward | DNS and image, at any time |
| Read scaling | RDS read replica (add `aws_db_instance` with `replicate_source_db`) | Neon read-only compute on the same branch (`scripts/neon-staging-branch.sh replica-create`) |
| Disaster recovery | automated backups (14 days) + cross-region snapshot copy | Neon PITR window (max 7 or 30 days by plan) + restore-point branches; replicas share storage and are **not** DR |
| Latency from `ap-south-1` | same region | **verify**: confirm Neon's nearest region and measure round trips before choosing; every query pays it |
| Existing Terraform | complete (`data.tf`, migrate task, alarms) | needs a `database_provider` switch: no RDS, `DATABASE_URL`/migrate-task secrets sourced from Neon, RDS alarms/logs removed |

## Decision
Option A. RDS PostgreSQL 16 in the private data subnets is the single production primary. Neon stays the source until cutover, then is retained read-only for the rollback window and decommissioned later. **Neon read replicas are not provisioned**: nothing can read from one, and they are not disaster recovery. The `replica-*` commands remain operator tooling for the Neon source only if a lag-free export read is ever needed; they are not part of the cutover. Data moves by native logical replication (runbook, Cutover step 2), which shortens the write freeze to the final switch instead of a full dump and restore. Revisit a read replica (RDS `replicate_source_db`) only with a designed, tested read path.

## Analysis behind the decision
Option B de-risks the cutover (no data move, real rollback) but moves data residency, latency and the network path outside the VPC, which the CTO blueprint (private database, `ap-south-1`) did not accept. Decide on: Neon region vs `ap-south-1`, whether an allowlisted public path is acceptable, and DR expectations. Do not mix: running RDS and Neon as primaries at once would give two sources of truth.

## What is built now (provider-neutral, safe under either option)
- `scripts/neon-staging-branch.sh replica-create|replica-status`: operator-run, idempotent, adds/lists a read-only compute on the production branch. Never prints credentials. Refuses nothing else; it does not touch data. The existing `env` production-host denylist already enumerates every endpoint of the production branch, so a replica host is denied to the staging migration tooling automatically.
- `tools/aws-golive-preflight.mjs`: static gate over the operator's production tfvars.

## What is deliberately not built
- **No application read path.** The API has one `DATABASE_URL` and one Prisma client; nothing reads from a replica. Routing reads to a replica interacts with forced row-level security, the per-request tenant setting and replication lag (a user must read their own booking write). It needs its own design: an explicit allowlist of lag-tolerant read endpoints (search, reporting), a separate runtime role and URL secret, and a test that proves a replica read cannot cross tenants. Until then a replica is capacity that nothing uses, and must not be described as a production capability (CLAUDE.md invariant 10).
- No Terraform switch for Option B, which cannot be validated until the provider registry is reachable and the owner chooses.

## Verification of this change
Replica commands exercised against a local stub of the Neon REST API (create, idempotent second create, status). `pnpm`-free tests: `node --test tools/aws-golive-preflight.test.mjs tools/aws-governance-check.test.mjs`. Not verified: any call to the real Neon API, ShellCheck, `terraform validate/test` (registry unreachable from the build environment).

## Rollback notes
Before the first write on RDS: set `create_portal_records=false` (DNS back to Vercel); Neon is still the live primary and untouched. After the first write: Neon is stale and cannot be merged back; roll forward, or restore the RDS snapshot taken at the freeze and accept loss of later writes. Neon `main` is protected with a restore point kept until the 14-day Vercel retention ends.
