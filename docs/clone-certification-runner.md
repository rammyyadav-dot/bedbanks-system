# Production clone certification runner

This runner is prepared for owner review. It has **not** certified the persistent clone. It cannot authorize a production migration.

The repository is public. Do not commit connection strings, hostnames, project/branch identifiers, tenant data, or raw database/test logs. The original detailed assessment remains outside the published branch. CI emits aggregate results only.

## Required owner setup

1. Create the GitHub Actions environment `fbeds-clone-certification`. Configure a required reviewer and limit deployment branches to `fix/clone-certification-runner`. Verify those controls before supplying credentials.
2. Reinspect the intended disposable production child in Neon. Confirm it is neither primary nor default and its endpoint belongs to that child. Record the direct endpoint; pooled endpoints are rejected. Confirm its schema and migration history match the approved baseline. This independent provider identity check is mandatory: the runner validates the supplied attestation, but has no Neon management token to query branch metadata itself.
3. Store `FBEDS_CERT_CLONE_DATABASE_URL` as an **environment secret**, containing only that clone's direct connection URL. Use `sslmode=require` or `sslmode=verify-full`. Never reuse a production connection reference.
4. Store `FBEDS_CERT_CLONE_TARGET_JSON` as an environment secret, using the following shape. Replace every placeholder using verified Neon metadata and read-only preflight. Do not publish the completed JSON.

```json
{
  "releaseSha": "5c19dee520f2b41d8c7226ca6fd93a0e1d238cb9",
  "branchId": "br-<verified-clone>",
  "parentBranchId": "br-<verified-production-parent>",
  "branchName": "cert-prod-schema-compat-<name>",
  "primary": false,
  "default": false,
  "hostname": "ep-<clone>.<region-host>.neon.tech",
  "productionHostnames": ["<verified-production-host>"],
  "database": "neondb",
  "role": "<clone-migration-role>",
  "verifiedAt": "<ISO-8601-UTC-time>",
  "expectedLegacyRates": 13
}
```

5. After reviewing the workflow and exact branch commit, set environment variable `FBEDS_CERT_ALLOW_CLONE_WRITE=yes`. Approve the environment job. A push to this exact review branch starts the workflow; if a previous run stopped for missing secrets, rerun that job after setup. `workflow_dispatch` is also declared, but GitHub may require the workflow to exist on the default branch before exposing manual dispatch. No merge is authorized by these instructions.

Attestations expire after six hours. The runner requires this exact application/migration baseline and refuses partial migration state. If the clone has already been mutated, do not use migrate resolve or rerun against it blindly: inspect the evidence and create a fresh clone for another attempt.

## What runs

- Validate target, read exact committed SQL bytes and checksum history, reject unresolved/partial migration state, check supplier mappings and availability, fingerprint legacy rates/availability privately in memory.
- Prisma validate/generate/status/deploy/status/drift on the clone. Exactly five new history rows must appear and historical rows must remain unchanged.
- Check schema, enums, constraints, required index/FK names, RLS flags and policies, permissions and derived role bindings. Drift validates Prisma-modeled objects; raw SQL checks cover important nonmodeled invariants.
- Run API E2E including tenant isolation, supplier governance, inventory holds and Dubai 100-hotel/seven-day coverage, followed by preservation and drift checks. E2E creates synthetic fixtures and grants a NOLOGIN test role **on the disposable clone**. It does not use supplier credentials or activate a deployed booking endpoint.
- Run schema guard, type checks, lint, API unit/Admin authentication tests and full build. These commands receive a nonconnecting placeholder URL rather than the clone credential.

Only the safe summary `clone-certification-evidence/result.json` may be uploaded. Raw subprocess output is captured in memory and never printed or uploaded. A failed command records its label, time and exit code; investigate failures in an approved private runner if more detail is needed. No application business data is stored in the artifact.

## Remaining production gates

Even `CLONE_CHECKS_PASSED_REQUIRES_OWNER_REVIEW` leaves the actual HTTP database role, backup/PITR recovery point and tested restore, maintenance window, human approval and authenticated deployment smoke tests unresolved. No workflow here targets Production.
