# ADR 0088: Supplier extranet routes declare their permission; room drafts need no idempotency key

Status: **Built (API only; no schema or contract change).**

## Context
The 2026-10-22 CTO scan (`docs/audits/2026-10-22-cto-bug-report.md`, BUG-04 and BUG-05) found two gaps against the repository constitution:
- Supplier extranet controllers enforced permissions only inside services (`requirePermission`). Rule 2 says a controller declares and verifies a permission. A new route could be added with guards but no check, and nothing would fail.
- `PATCH supplier/extranet/hotels/:hotelId/rooms/:roomId/draft` takes no `Idempotency-Key`, and no decision was recorded.

## Decision
1. **Declare on the route.** `@RequireSupplierPermission(key)` is required on every handler of `SupplierExtranetController` and `SupplierChangeSetsController`; `SELF` marks the two routes that only answer about the caller's own memberships (`memberships`, `context`). `SupplierPermissionGuard` verifies it and **fails closed** when a handler declares nothing.
2. **Keep the service checks.** The services still call `requirePermission`, so a service reused from another entry point stays protected. The cost is one extra permission query per request; it is accepted for now.
3. **A test walks the routes.** `supplier-permission.guard.spec.ts` enumerates every handler on both controllers and fails if one lacks a declared permission.
4. **Room draft saves are not idempotency-keyed.** The route replaces a private supplier note with the supplied text, so repeating it gives the same result, and it is not a booking, cancellation, wallet, payment or webhook mutation (rule 6). It already writes an audit event.

## Consequences
New supplier routes must declare a permission or the guard test and the guard itself reject them. If room drafts ever carry more than a replace-style note (for example append or counters), add an idempotency key then.
