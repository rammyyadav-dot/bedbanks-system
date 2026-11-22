# ADR 0118 — Agent cancellation quote acceptance

Status: Accepted

The Agent cancellation endpoint requires an issued quote ID for a confirmed booking. Quoting records the booking version and integer amounts in the existing append-only booking audit trail. The ID is scoped to the tenant, booking and authenticated user. Responses use private, non-cacheable delivery and expire at two minutes, exclusive. Quote records follow existing audit retention.

Cancellation checks the quote under the booking lock, takes the wallet lock, and recalculates the penalty and remaining credit before any inventory or ledger mutation. Changed or expired quotes return a conflict and require fresh agency acceptance. Completed cancellations remain safe to replay. The successful cancellation audit records the accepted quote ID.

Deploy the API and Agent portal together. API clients should fetch a fresh quote from the existing quote endpoint and send its ID in the cancellation body. Admin and supplier servicing use their existing workflows.
