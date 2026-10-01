# ADR 0007: Contracted inventory is the agent search source

## Context
Agent search and recheck already depend on `SUPPLIER_ADAPTER`. The default
adapter was unconfigured, so a sellable contracted hotel could not appear in
search. Admin sellability remained a single-night check. Booking, payment, and
live supplier transactions are still out of scope.

## Decision
Bind `SUPPLIER_ADAPTER` to a contracted-inventory adapter that reads the
tenant's approved hotel and room mappings, active contract, active rate plan,
SELL daily rates, and availability. It returns canonical offers only. Amounts
are integer minor units summed with bigint. NET and unclassified rates stay
non-sellable.

Search results for this adapter are not response-cached, so a stop-sell or
price change is visible on the next search. Recheck recomputes the stay from
current rows and keeps the original offer expiry. A different total is
`price_changed`. Missing or unsellable inventory is `unavailable`. An elapsed
offer is `offer_expired`. A tenant with no supplier row is `provider_unavailable`
and returns no hotels.

`prebook` and booking confirmation stay fail-closed. The single-night admin
sellability reasons are unchanged and now call the same night helper.

## Consequences
One approved Dubai hotel can be searched and rechecked from authoritative
rows. Scaling past the adapter's current plan read limit, and any live
supplier booking, needs a separate decision. No schema change is required.
