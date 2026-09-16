# 0003: Server-enforced tenant isolation

## Status
Proposed.

## Decision
Tenant context must be derived from the authenticated user and checked against membership for every tenant-scoped request. PostgreSQL row-level security is evaluated when the data-access layer is standardized; guards alone are not the final isolation strategy.

## Consequences
No request body or query parameter can independently select an authorized tenant. Cross-tenant tests become a release gate.
