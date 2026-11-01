# ADR 0062: Sign-in abuse protection, API documentation exposure, and the owner role

## Status
Accepted (closes CTO audit findings F01, F07, F08, F09 of 13 October 2026).

## Context
The audit found: authentication audit events silently rejected by row-level security (F01); no login throttling (F08); the Swagger UI served unconditionally (F09); and `AdminRbacGuard` letting a tenant `owner` bypass the formal permission list (F07).

## Decision
1. **Authentication audit (F01).** Authentication events have no tenant. A narrow insert-only policy (`AuditEvent_auth_insert`, migration `202611180001`) admits exactly four actions, tenantless, inside a transaction that sets `app.auth_audit`, written without `RETURNING` (tenantless rows have no SELECT policy). A persistence failure never blocks sign-in but is logged as `auth_audit_persist_failed` with the action and database error code only.
2. **Sign-in throttling (F08).** Failed sign-ins are counted over a 15-minute window: 5 per account and address, 20 per address. Over the limit the API answers `429` with `Retry-After` and code `LOGIN_THROTTLED` before any password work. Success clears the account counter. Counting per account *and* address means a stranger cannot lock the real user out from another address.
   - **Limit of this control:** state is per API process. With N instances the effective limit is up to N times higher, and behind a proxy `req.ip` is the proxy unless Express `trust proxy` is configured. Release needs (a) an edge/WAF rate limit on `POST /auth/login`, and (b) `trust proxy` set to the real hop count at deployment. A shared store (Redis) is the follow-up if the edge limit is not available.
3. **API documentation (F09).** `/api/docs` is not registered when `NODE_ENV=production`. There is no flag to turn it back on; use the committed contracts or a non-production environment.
4. **Owner role (F07).** The tenant `owner` membership keeps full admin access without per-permission rows. Rationale: an owner must always be able to recover a tenant whose role assignments are misconfigured. Control that makes this acceptable: revocation takes effect on the next request, because the membership is re-read from the database on every request (covered by the tenant-control end-to-end test "revokes membership access on the next authenticated request"). Not yet verified, and to be confirmed before launch: who can grant `owner`, and that every privileged or financial route writes its audit event regardless of actor. Revisit if owners become self-service.

## Consequences
- New migration; rollback notes are in the migration file. No table, column or index changes.
- Operators must configure the edge rate limit and proxy trust before launch (tracked in the release checklist).
