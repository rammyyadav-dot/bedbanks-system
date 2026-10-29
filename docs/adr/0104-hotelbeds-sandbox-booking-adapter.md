# ADR 0104: Hotelbeds sandbox booking adapter

## Status
Proposed. Fixture-tested; no real sandbox evidence.

## Context
The Admin booking queue calls a supplier through `BookingSupplierPort` (ADR 0039). Only a mock and an XML adapter exist. The Hotelbeds sandbox transport (docs/supplier-sandbox-integration.md) could search and recheck but deliberately could not book.

## Decision
1. Extend the sandbox transport with book, cancel and lookup-by-client-reference, behind a separate `bookingEnabled` flag (default false). Hosts stay the Hotelbeds test host; DELETE and the new POST are never auto-retried.
2. Keep Hotelbeds wire shapes and parsing in `@bedbanks/connectors-core`; `HotelbedsBookingSupplier` in the API only translates to port outcomes (invariant 9).
3. Idempotency: the supplier has no key, so `clientReference` is derived from our `FB-` reference and the supplier is asked by it. Only a supplier 4xx is a refusal; every other failure is "unknown" and goes through the runner's status check.
4. Price integrity: send `tolerance: 0` and require the booked net to equal the expected net in integer minor units.
5. Do not register the adapter in `BookingSupplierRegistry` until a guest-data resolver backed by the audited booking store exists and a real sandbox run has passed `book-cycle`.

## Consequences
- Rollback: remove the adapter file and the three transport methods; nothing else depends on them. No schema or migration change.
- Sandbox hotels still cannot become canonical inventory, so this proves the supplier call path, not sellable inventory.
- Rate and quota coordination remains single-process.
