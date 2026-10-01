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
Approved Dubai hotels can be searched and rechecked from authoritative rows.
The adapter does not apply a global rate-plan ceiling. It first selects the
tenant's complete candidate hotels for the destination, ordered by id, then
reads active rate plans in batches of 25 hotels. Each batch is ordered by
rate-plan id and includes only mapped room rows for the requested nights.
Sellability still drops unsellable plans after those reads. A disposable
search of 100 Dubai hotels and 300 matching plans still returns every
sellable hotel. Hotels are ordered by name, then hotel id. The response
window is `offset` plus `limit` and is applied once, after evaluation, so
later pages neither repeat nor skip a sellable hotel. `pagination.total` is
the matched count; `total` remains the number of hotels in that page. Search
results for this adapter
stay uncached. Live supplier booking remains a separate decision. No schema
change is required. Admin sellability remains a single-night check.
