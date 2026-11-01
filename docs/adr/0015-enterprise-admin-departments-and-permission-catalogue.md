# ADR 0015: Enterprise Admin departments and the permission catalogue

## Status
Accepted for the catalogue and navigation. No permission was renamed, added to a role or enforced by this change. ADR 0013 (production role access) is unchanged.

## Context
Admin navigation grew by feature (Commercial, Operations, Finance). A global bedbank is run by departments: contracting, supply, mapping, rates and inventory, reservations, reconciliation, finance, platform administration and others. The target permission model uses `<domain>.<resource>.<action>` keys, scope, action classes and maker-checker approval. The API already enforces a smaller set of keys (`supply.*`, `booking.*`, `finance.read`, `audit.read`) from formal role assignments and fails closed.

## Decision
1. **Departments are views over shared domains.** `@bedbanks/contracts` holds one catalogue of departments and modules (`admin-departments.ts`). The sidebar is derived from it. Nothing is copied per department.
2. **Only live modules render.** A module is `live` (a real route backed by an authoritative API) or `planned` (no route, no sidebar entry). A planned module cannot be reached from the Admin, so no placeholder is presented as a capability (repo invariant 10).
3. **Every permission has a status.** `enforced` keys are the ones an API guard checks today. `planned` keys are named from the department matrix, granted to nobody and checked nowhere. A planned key may say which enforced key it `refines`; renaming or splitting an enforced key is a separate reviewed migration with role data migration.
4. **Action classes.** S0 read, S1 routine, S2 commercially sensitive, S3 transaction or security critical. S3 actions use maker-checker (ADR 0016). `*.read` keys are always S0.
5. **Scope.** The tenant is the hard boundary and comes only from the session. Region, country and destination are business scope until the backend enforces them. Platform keys (`PLATFORM` scope) never imply tenant membership.
6. **Forbidden keys.** Held and sold inventory, ledger and wallet balances, generic booking status or confirm, and `*.all` wildcards must never exist. A test fails if the catalogue defines one.
7. **The UI never authorizes.** `requires` in navigation hides an item; the API remains the authorizer and tenant RLS remains defence in depth.
8. **Role composition, not inheritance.** Roles are sets of permissions plus scope. Seniority does not imply operational permissions.

## Alternatives rejected
- Renaming `supply.*` keys to the target form now: breaks existing role data and guards for no behavioural gain.
- Showing planned departments greyed out: a visible route implies a capability.
- A department-specific authorization check per page: duplicates policy and drifts.

## Consequences
- A test in the API asserts the catalogue matches the enforced keys, that no planned key is checked or granted in API source, that every live module has an enforced gate, and that forbidden keys stay out.
- Adding a department module means adding the API, guard, audit and tests first, then flipping it to `live`.
- Rollback: revert the navigation derivation to a literal list. The catalogue file has no runtime effect on the API.
