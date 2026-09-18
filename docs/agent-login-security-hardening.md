# Agent login security hardening

## Scope

This phase hardens the fBeds Agent Portal login, workspace selection, authorization boundary, and honest supplier-unavailable experience. It does not connect a hotel supplier or implement booking operations.

## Implemented

- Polished enterprise login flow with fBeds branding, accessible labels, password visibility control, generic failed-login messaging, loading protection, and session-expired messaging.
- Preserved opaque HttpOnly cookie sessions; authentication data is not stored in localStorage.
- Kept the API as the authorization boundary. Agent requests require a valid session, a server-validated active tenant header, and formal permissions where applicable.
- Sanitized agent-facing 401/403 errors to `Session expired` and `Access denied`.
- Added server audit events for login success/failure, logout, expired/revoked sessions, tenant access denial/context selection, and permission denial.
- Required explicit workspace selection for multi-tenant users. Every workspace status request is made with the selected tenant context and revalidated by the API.
- Removed the demo hotel portal from the authenticated Agent route. When no supplier is configured, the portal shows: “Live hotel inventory is not yet connected for this workspace.” No demo inventory or bookable rates are rendered.
- Added responsive mobile styling, visible focus states, semantic labels, and keyboard-operable controls.

## Authorization source of truth

Formal `Role`, `Permission`, `UserRole`, and `RolePermission` records are the source of truth for new authorization logic. The API `AgentRbacGuard` checks these relationships per tenant and per request. The legacy `Membership.role` string remains only as a compatibility fallback for existing seeded owner/finance memberships and must be removed after migration completion.

## Tenant context behavior

The active tenant is selected in memory by the Agent workspace screen and sent as `x-fbeds-tenant-id` for protected requests. `TenantContextGuard` validates the authenticated user’s active membership and tenant status against the database on every request. A missing, inactive, or unrelated tenant returns a generic access-denied response and records an audit event.

## Supplier-unavailable behavior

The configured adapter remains `UnconfiguredSupplierAdapter`. Search returns no inventory and mutation boundaries remain unavailable. The Agent route does not render static hotel data. Supplier setup must be completed before live availability, rates, recheck, prebook, booking, or cancellation can be exposed.

## Known blockers before external beta

- Select and configure a real hotel supplier sandbox and production adapter.
- Complete transaction-backed booking, cancellation, idempotency, and finance posting workflows.
- Finish removal of legacy free-form role fallback.
- Add login throttling/rate limiting and confirm infrastructure-level CSRF policy for all cookie-authenticated mutations.
- Add full browser E2E coverage once a stable seeded API/database environment is available.
- Add production security headers/CSP after deployment origins and API endpoints are finalized.

## Manual QA checklist

- [ ] Open the Agent route while signed out; login form is keyboard-complete and labels are announced.
- [ ] Submit invalid credentials; only the generic error is shown.
- [ ] Toggle password visibility; accessible label changes between show/hide.
- [ ] Sign in successfully; one workspace is selected automatically, multiple workspaces require a choice.
- [ ] Switch workspace; supplier and finance status refresh and the selected tenant is sent to the API.
- [ ] Attempt an inactive or unrelated tenant ID; API returns access denied.
- [ ] Revoke or expire the session; the next request shows the session-expired path.
- [ ] With no supplier configured, confirm no hotel cards, rates, prices, or booking buttons are displayed.
- [ ] Sign out; the session cookie is revoked and the login screen returns.
- [ ] Test at desktop and mobile widths with keyboard-only navigation.
