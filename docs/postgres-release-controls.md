# PostgreSQL release controls

## Operating model

The HTTP application role must be non-owner, non-superuser and must not have `BYPASSRLS`. It receives only the required table grants. `PrismaService.withTenant()` establishes `app.current_tenant_id` inside one transaction; the setting is released at transaction end, preventing pool leakage.

The migration owner is separately governed. A restricted background role may perform explicitly approved work; a read-only operational/audit role may only read approved views or tables. Ordinary HTTP requests must never use either privileged role.

## Currency governance

Launch settlement currencies: AED, USD, EUR, INR, GBP, SAR, QAR, OMR, KWD, BHD, SGD, AUD, CAD and JPY. Inputs must match this allowlist exactly; lowercase, whitespace and unsupported codes are rejected.

## Ledger and audit controls

Tenant application roles may select and insert ledger/audit records only within RLS context. PostgreSQL policies do not permit UPDATE or DELETE, and the ordinary tenant application role cannot insert `SYSTEM` audit events. Retention, legal-hold and system-event operations require the governed restricted process.

## Retention policy template

Define approved retention periods for audit and booking/finance records; preserve legal holds; require deletion approval and evidence; minimise PII in payloads; and restrict incident-investigation access to authorised personnel with an audit trail.

## CI evidence and release decision

CI proves disposable PostgreSQL migration replay, drift, RLS controls and API E2E tests. Only the database owner can prove production history, backup restoration, role grants, pool configuration, secret storage and monitoring. fBeds remains blocked from production booking until every owner-controlled checklist item is signed off.

## PostgreSQL 16 owner roles (P0.4 certification)

A managed-service owner is usually `CREATEROLE` but not a superuser. On PostgreSQL 16 such an owner cannot name `SUPERUSER`, `REPLICATION` or `BYPASSRLS` in `ALTER ROLE`, and needs an explicit membership (`GRANT role TO CURRENT_USER`) to `SET ROLE` to, or `DROP OWNED` for, a role it created. The provisioning code handles both (it fails closed if an existing login role is already elevated). Migrations that grant to `fbeds_api` run only when that role already exists, so the grants an environment ends up with depend on order; provisioning is authoritative and `verifyApiRuntimeRole` reports pool-table writes. See `docs/p04-postmerge-inventory-certification.md`.

