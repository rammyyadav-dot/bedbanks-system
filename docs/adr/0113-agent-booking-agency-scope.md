# ADR 0113: Agent booking agency scope

## Status
Accepted for implementation.

## Context
Agent booking list filtered by tenant only. Detail, confirmation, cancellation and documents located a booking by tenant and booking id. The guards check tenant membership and a permission. They do not check that the booking belongs to the caller's agency. Two agencies of one bedbank operator therefore shared a booking list, and a known booking id was enough to read or act on the other agency.

`AgencyMember` is already the authenticated link from a user to one agency in a tenant. Bookings store that agency. Unassigned bookings (a null agency) are visible only to operator-level readers. `booking.read` remains the operator-level read (ADR 0039). The Agent portal also grants it to agency users, so the permission alone cannot decide the scope.

## Decision
Every Agent list, detail, confirmation, cancellation quote, cancellation and document lookup resolves scope inside the tenant transaction:

- An `AgencyMember` row limits the caller to that `agencyId`, including when the caller is an owner or also holds `booking.read`. A booking id outside that agency is not found. The row lock uses the same predicate, so another agency's booking is not locked.
- Operator access is separate. It applies only when the caller has no agency membership and holds operator read: legacy owner membership, or a formal `booking.read` role. The caller then sees every agency in the tenant, including unassigned bookings.
- A caller with neither an agency nor operator read is refused. A missing agency row is not tenant-wide access.

The agency id is never taken from the query, the body or a header. Admin booking access (ADR 0039) is unchanged.

## Consequences
Removing an agency membership from a user who still holds `booking.read` (or who is an owner) restores operator scope. Remove that grant when the person must not see other agencies. Historical bookings with a null agency stay visible to operators only. No schema change: `(tenantId, agencyId, status)` is already indexed. Rollback is reverting this application check; the data model stays as it is.
