# ADR 0085: Connector administration and secret resolution

Status: Accepted (API, resolver and permissions built and tested; no supplier is wired and no deployment is configured)
Date: 2026-10-22

## Context
The XML supplier audit (2026-10-12) left two blockers before any live supplier: F3, `secretRef` was stored but nothing resolved it, and F4, connectors could not be created, activated or given credentials through the
API. Two decisions shape both: a stored reference is tenant-influenced data, so it must never be able to select a secret it should not reach; and activating a connector is the dangerous step, so it is maker-checker.

## Decision
**F3: secret resolution** (`apps/api/src/connectors/connector-secret-resolver.ts`).
- A reference is `aws-sm:<secret name>`: a location, never a value. Names only, never ARNs, so a reference cannot select another account or region.
- The deployment sets `CONNECTOR_SECRETS_PREFIX` (for example `fbeds-prod/connectors`). Unset means nothing resolves. A reference must lie under `<prefix>/<tenantId>/<connectorId>/` of the connector asking, so another
  tenant's secret, another connector's secret and platform secrets such as `<env>/api/DATABASE_URL` are refused before any call. The task role should be granted `secretsmanager:GetSecretValue` on that prefix only.
- The value must be a JSON object of at most 20 short string values (8 KiB). Failures carry a code only (`not_configured`, `invalid_reference`, `out_of_scope`, `not_found`, `malformed`, `unavailable`); no message, log line
  or error carries a reference or a value. Successful reads are cached in memory (default 60 s, at most 300 s, 0 disables, 100 entries); failures are never cached.
- `asTransportResolver(validate)` adapts it to the XML transport's `resolveSecret` port; the provider profile validates the shape of its own secret. `check()` reports whether a secret is usable without returning it.

**F4: connector administration** (`/supply/connectors`, contracts first).
- Permissions: `supply.connectors.read` (S0) and `supply.connectors.manage` (S2), both granted to no role by the data-only migration `202612050001`; approval-only action `connector.activate` (S3) refining manage.
- Create: a DRAFT connector from a strict body (supplier of this tenant, type, name, version, declared capabilities). Only read-only capabilities may be declared (`search`, `recheck`, `content`, `availability`, `status`); `prebook`, `book` and
  `cancel` are refused because each needs its own approved activation, which is not built. No route accepts an endpoint or secret material: transport metadata starts empty and endpoints stay operator configuration (ADR 0060).
- Credential references: attach or replace one per purpose, only on a DRAFT or SUSPENDED connector, only under the connector's own prefix (the same rule the resolver applies). Reads show the purpose and `configured`, never the reference.
  Audit events carry a 12-character hash of the reference.
- Activation (DRAFT or SUSPENDED to ACTIVE): requires at least one credential reference and a different person's approval. The approval is bound to a fingerprint of the version, capabilities and credential-reference hashes. Execution re-checks
  the status and the fingerprint, and that every referenced secret resolves to well-formed material, then activates once. A missing secret leaves the approval usable for retry.
- Suspend and disable are direct (the safe direction), with a reason, audited. DISABLED is final.
- All mutations are audited (`connector.created`, `.credential_reference.set`, `.activated`, `.suspended`, `.disabled`); tenant identity comes from the session; reads and writes are tenant-filtered.

## Authority (what this does not change)
`ConnectorDefinition` and `ConnectorCredentialReference` are privileged write paths (`PRIVILEGED_WRITE_MODELS`): the strict API runtime role has no write grant, and this change adds none, so on a strict deployment these writes answer
the typed 403. A narrow connector-admin role, like ADR 0076 and 0079, is the follow-up before this API can be used there. Nothing in the API can read a secret value; the only reader is the resolver.

## Not built (invariant 10: do not present as capability)
- No supplier uses the resolver: no profile exists and none is registered. No egress, no calls.
- No deployment configuration: `CONNECTOR_SECRETS_PREFIX`, the IAM policy on that prefix and the secrets themselves do not exist anywhere. The infrastructure code was not changed.
- No narrow role for connector writes (above), no Admin screen, no per-capability approval for mutating capabilities, no secret rotation workflow, no `ConnectorExecution` persistence (F5), and the old Admin operations connector list
  still requires `booking.read` (F9 is only partly closed).
- The in-memory cache is per process; a rotated secret is picked up within the cache time, not immediately.

## Rollback
Remove the `ConnectorsModule` import, the `src/connectors` directory, the contracts file and route entries, the catalogue entries and the SDK dependency. The migration only inserts two catalogue rows (rollback statements in its header).
No schema or data change.

## Verification
`connector-secret-resolver.spec.ts` (9 tests: scope, traversal, ARNs, malformed material, no leakage, cache, startup validation, the AWS store mapping) and `test/connector-admin.e2e-spec.ts` (6 tests on PostgreSQL 16, in-memory store: strict create,
credential-reference rules and audit, maker-checker activation including the missing-secret retry and single use, change-after-approval refusal, locked and suspend/reactivate/disable lifecycle, tenant isolation and a foreign approval refused).
The permission catalogue and runtime-role contract specs, the contract check (39 controllers), `pnpm check:dependencies` and the full API unit suite pass.
