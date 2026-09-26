# Supplier recheck and inventory hold boundary

This boundary connects a canonical search selection to a non-bookable inventory hold. It does not create a booking, supplier confirmation, payment or cancellation capability.

## Request sequence

1. Session authentication, tenant membership and `booking.prebook` permission are verified.
2. The supplier adapter rechecks `offerId` plus `searchId` within a five-second timeout.
3. The API validates the normalized authority response, expiry, occupancy, ISO currency and integer minor-unit amount.
4. PostgreSQL revalidates the active supplier, mapped hotel and room, canonical content, board basis, contract and rate plan inside tenant RLS context.
5. A changed currency or sell amount returns `price_changed` and does not allocate inventory.
6. An unchanged, available offer is passed to the atomic inventory-hold service. PostgreSQL remains the concurrency authority.

## Outcomes

| Outcome | HTTP | Inventory mutation |
| --- | ---: | --- |
| `held` | 201 | Atomic hold or idempotent existing hold |
| `price_changed` | 409 | None |
| `unavailable` | 409 | None |
| `offer_expired` | 410 | None |
| `mapping_invalid` | 422 | None |
| `provider_unavailable` | 503 | None |
| `rejected` | 400 | None |

Supplier authentication, timeout, transport and malformed-provider failures are classified server-side but share the sanitized `provider_unavailable` client outcome. Raw payloads, endpoints and credentials are never returned or written to audit payloads.

## Authority and idempotency

The client may submit only the expected display currency/amount and an idempotency key. Supplier, mapping, contract, rate-plan, stay and occupancy authority comes from the normalized supplier recheck result and is independently checked against the tenant database. The hold service retains its tenant-scoped unique idempotency key and SHA-256 commercial fingerprint; identical active retries resolve to the same hold and conflicting reuse fails closed.

## Cache and locking

Static capabilities and non-authoritative display metadata may use bounded, tenant/version-scoped caching. Live availability, final price, stop-sell state, mappings used for authorization, inventory balances and holds are authoritative reads. Cache misses never fabricate data. Redis/Redlock remains unconfigured; database transactions and constraints provide correctness.

## Release limits

- The default adapter is deliberately unconfigured and returns no live availability.
- A live connector must implement the provider-neutral recheck contract and undergo separate credential, timeout and payload review.
- Booking, payment, cancellation and supplier confirmation remain disabled.
- The booking-concurrency migration is not approved for persistent deployment until database-owner release controls and qualified human review are recorded.

## Agent Portal behavior

The Agent Portal sends only the selected offer/search references, the displayed currency and sell amount, and a browser-generated idempotency key. It validates the canonical response before rendering it. Unavailable, expired, mapping-invalid, rejected, authentication and provider-failure outcomes never become a booking or optimistic success state. A same-currency price change may be explicitly accepted and rechecked; a currency change requires a new search. A successful result is labelled as a temporary hold with its expiry and an explicit statement that no booking or supplier confirmation exists.
