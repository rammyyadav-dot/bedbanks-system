# ADR 0014: Canonical destination and room-level search occupancy

## Context
Agent search accepted a destination string and one shared occupancy. A typed
string could be submitted without a catalogue id, and a price filter assumed
two decimal places. Hotel content, cancellation deadlines, and property type
already exist on the hotel master and contracted rate plans. There is no area
or photo model.

## Decision
The agent submits a canonical destination ref. A city ref searches that city
by exact name. A hotel ref searches that hotel id. The server resolves the ref
against the tenant's COMPLETE hotels and rejects a ref that no longer exists.
Requests without a ref stay valid so existing destination-string callers keep
working. The agent UI does not submit free text.

`roomStays` records adults and child ages per room. When every room matches,
`adults`, `children`, and `childAges` stay the per-room occupancy used by
contracted rate plans. When rooms differ, the aggregate is the sum and the
contracted adapter returns no offers rather than a combined rate.

Price filters are integer minor units of the selling currency. Conversion uses
the shared currency exponent. Star rating, board, refundable, property type,
and price filters, plus price, star, and name sorts, run before the page
window. Page size stays 25.

Optional hotel fields are address, property type, coordinates, and timezone,
copied only when stored. A free-cancellation deadline is included only when
the rate is refundable and the contract rules define one unambiguous penalty
start. Booking stays behind the existing `BOOKING_ENABLED` gate. No new
supplier is connected.

## Consequences
Dubai search continues on contracted inventory. Mixed room occupancies are
visible on the request and are not priced. Missing photos and areas stay
missing. An ambiguous prebook still requires reconciliation and does not offer
a second prebook of the same hold.
