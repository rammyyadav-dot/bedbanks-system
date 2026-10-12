# ADR 0061: Connector secret resolver (AWS Secrets Manager)

Status: Accepted. Date: 2026-10-12.

## Context
`ConnectorCredentialReference.secretRef` stored a reference but nothing resolved it. Until now the apps called no AWS API and task roles had no permissions (`iam.tf`).

## Decision
1. The API resolves supplier-connector credentials at call time from AWS Secrets Manager (`ConnectorSecretResolver`, `apps/api/src/connectors`). Material goes only to the transport's request builder; it is cached in memory for 60 s at most, never persisted, logged, or put in an error.
2. Reference format `aws-sm:<CONNECTOR_SECRET_PREFIX><tenantId>/<connectorId>/<purpose>`. The prefix (`fbeds-<env>/connectors/`) is set by Terraform. The tenant and connector segments must equal the server-derived scope, so a connector row can never reach another tenant's secret or a platform secret (invariants 1 and 7). Validation happens before any AWS call.
3. Secret values are flat JSON objects of non-empty strings.
4. Without `CONNECTOR_SECRET_PREFIX` the resolver is the unconfigured one and every call fails with `unconfigured`; there is no environment-variable or default fallback.
5. IAM: only the `api` task role gets `secretsmanager:GetSecretValue` on `fbeds-<env>/connectors/*` plus `kms:Decrypt` on the data key via Secrets Manager only. No list/write. It cannot read the database, Redis or owner secrets. Secret values are created by operators out of band and never appear in Terraform state (`check:aws-governance` still enforces this).

## Consequences
- Adds `@aws-sdk/client-secrets-manager` to the API. First AWS API use in an app; the grant is the narrowest practical.
- Rotation: operators put a new secret version; the 60 s cache bounds staleness. No rotation automation is claimed.
- Not yet bound to a connector (no connector is composed); that happens per supplier.

## Rollback
Remove `apps/api/src/connectors`, the dependency, the `api_connector_secrets` policy and `CONNECTOR_SECRET_PREFIX`. No data migration.
