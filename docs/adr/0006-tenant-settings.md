# ADR 0006: Tenant-scoped Admin settings

## Context
The Admin Settings page was a non-persisting placeholder. Platform tenant
directory access is a separate permission surface. Admin RBAC already evaluates
tenant membership and `settings.manage`.

## Decision
Store workspace preferences in a 1:1 `TenantSettings` row, not as growing
columns on `Tenant`. `GET`/`PATCH /admin/settings` read tenant identity only
from the authenticated session membership (owner membership if present,
otherwise the first membership). Request bodies and queries cannot select a
tenant.

Money fields use integer minor units serialized as decimal strings plus ISO-4217
currency. `defaultCurrency` and the low-balance threshold are display and alert
preferences. They do not rewrite wallets, ledger entries, or historical
bookings, and they do not perform FX.

`PATCH` requires an `Idempotency-Key`. The same key with the same normalized
payload returns the current row; the same key with a different payload is 409.
Successful updates write an immutable `settings.updated` audit event.

## Consequences
Existing tenants receive a settings row on first read. A future wallet-alert
worker can consume the threshold without changing this contract. Platform-wide
white-label configuration remains out of scope.
