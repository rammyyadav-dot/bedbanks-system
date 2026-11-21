# ADR 0117: Revalidate booking scope with restricted authorization columns

Status: Accepted correction to ADR 0113's booking transaction contract.

Booking history, cancellation and document issuance revalidate tenant membership, revocation, agency membership and formal operator permission inside their transaction. The booking login could not read the first of those facts. Full HTTP testing exposed a 503 on booking history even with a correctly configured restricted login. Resolving scope with the owner or removing revalidation would violate the boundary.

Grant column-only SELECT on membership identifiers, tenant, legacy role and revocation; tenant status; tenant role assignments; role identifiers; permission links; and permission keys. Narrow `resolveAgentBookingScope` selects to precisely those facts. Preserve the existing tenant predicates, forced RLS, agency-first scope and formal `booking.read` requirement for operators. No new INSERT/UPDATE/DELETE permission is granted on authorization metadata. User credentials, sessions, reset tokens and finance-posting tables remain forbidden. Whole membership rows and role descriptions remain unreadable.

The catalogue verifier checks both missing and extra column privileges. PostgreSQL tests exercise agency scope even with operator grants, foreign-tenant refusal, formal operator scope after agency removal, and membership revocation. The real HTTP booking-history suite runs through a dedicated restricted login. The booking wrapper also preserves requested transaction isolation and timeout through its existing narrow connection, verified with PostgreSQL's `transaction_isolation` setting.

Deploy using the existing owner-operated booking-role provision/certification procedure after review. No persistent grant is changed by this implementation task, and no migration is added or renamed. The scope policy itself is unchanged; this makes its database principal capable of evaluating it.
