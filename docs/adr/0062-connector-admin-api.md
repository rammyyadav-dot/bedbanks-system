# ADR 0062: Admin connector API (DRAFT-only, reference-only)

Status: Accepted. Date: 2026-10-12. Amends ADR 0032 (explicit runtime write set).

## Context
Connectors could not be created or given credentials through the API; the tables had no runtime write grant, and an earlier spec asserted the runtime role must never write `ConnectorCredentialReference`.

## Decision
`/supply/connectors` (contracts `routes.supply.connector*`): list, get, readiness, create, edit, attach/replace/remove credential reference.
- Permissions reuse the existing `supply.suppliers.read` (view) and `supply.suppliers.manage` (change). No new permission or catalogue migration. A denial writes `permission.denied`.
- Tenant comes from the authenticated context; a body `tenantId` is an unknown field and refused. Create needs `Idempotency-Key` (replay returns the same connector; a different body is a 409).
- **The API cannot make a supplier live.** `status`, `capabilities` and `health_state` are not accepted by the API and are not in the runtime column grant. Connectors are created DRAFT. Activation stays a privileged operator action, and no provider profile above FIXTURE_ONLY exists. Readiness (`evaluateReadiness`) is computed from real state and reports `NOT_IMPLEMENTED`.
- Transport metadata is an allowlist (`provider`, `endpointHost` as a bare host, `wireFormat`, `specVersion`); any key that looks like secret material is refused.
- Credential references must be `aws-sm:<CONNECTOR_SECRET_PREFIX><tenantId>/<connectorId>/<purpose>` (the same validator the ADR 0061 resolver uses), so a stored reference can only ever point at the connector's own secret. With no prefix configured nothing can be stored. Responses never echo the reference and audit payloads carry a 16-hex digest only.
- An ACTIVE connector's transport metadata and credentials are locked against edits.
- Every write creates an immutable `AuditEvent` in the same transaction.

## Runtime role change (reviewed reversal)
Migration `202611160001_strict_runtime_role_connector_admin`; contract entries in `runtime-role-contract.ts`; matrix regenerated.
- `ConnectorDefinition`: SELECT, INSERT, UPDATE(name, version, transport_metadata, updated_at).
- `ConnectorCredentialReference`: SELECT, INSERT, DELETE, UPDATE(secret_ref, updated_at).
The previous rule "the runtime never writes `ConnectorCredentialReference`" is replaced by this narrower rule. Residual risk: the scope check on a reference is application-level; a compromised API process could store a reference to another tenant's connector secret path. The backstop is IAM, which limits the API to `fbeds-<env>/connectors/*` only (ADR 0061), and per-tenant path separation is a convention, not an IAM boundary. If tenants must be isolated even from a compromised API, move credential writes to a dedicated narrow role and per-tenant IAM before onboarding untrusted tenants.

## Rollback
`REVOKE ALL ON "ConnectorDefinition", "ConnectorCredentialReference" FROM fbeds_api` (routes then answer a typed 403), remove the module wiring. No data change. Index review: existing `(tenant_id, status)` and `(supplier_id, name)` cover the queries; no new index.
