# ADR 0065: Agent search bar: typo-tolerant destinations, Smart Search parser, client markup

Status: Accepted. Partly implemented; the "Not built" section is the honest boundary of what this change delivers.

## Context
The agent search bar is being brought in line with B2B bedbank portals (TBO, WebBeds, Hotelbeds): one wide destination field, a date range, an occupancy matrix and a Search button, with a second bar for guest nationality, an agent's own client markup and a "Smart Search" box that turns a pasted client request into search fields.

Constraints from the repository constitution: tenant identity only from the server session (1); a permission on every tenant route (2); integer minor units, no floats (3); contracts before the frontend (4); no placeholder presented as a capability (10); never log guest PII (7).

## Decision
**Destination typeahead (PostgreSQL `pg_trgm` + Redis, no Elasticsearch).**
- `DestinationResolverService.search` keeps its tenant- and RLS-scoped read of published (`contentStatus = COMPLETE`) hotels and adds typo tolerance: candidates come from `contains` *or* trigram `word_similarity >= 0.35` on name and city, ranked by similarity. `pg_trgm` is already installed (migration `202610010003_hotel_search_index`); no schema change.
- Multi-language names and common variants go through a small reviewed alias table in `@bedbanks/domain` (`destinationAliases`: e.g. دبي/Dubaï/Dubay → Dubai, Bombay → Mumbai). Aliases only rewrite the *query*; a result is still a real catalogue city or hotel.
- Results are cached cache-aside per tenant and normalised query for 60 s (ADR 0064 `CacheAside`, static content only). A cache fault falls through to the database.
- Elasticsearch was rejected: a new service, an indexing pipeline and tenant isolation outside PostgreSQL RLS, for a catalogue measured in thousands of hotels.

**Smart Search (built-in parser, no LLM).**
- `parseSmartSearch(text, today)` in `@bedbanks/domain/smart-search` is deterministic and transport-agnostic. It extracts destination text, check-in/check-out (ISO, `23 Oct`, `23/10`, `today`, `tomorrow`, `next Friday`, `in 5 days`), nights, star ratings, rooms, adults, children and child ages, and nationality (country names and demonyms limited to the supported guest markets).
- `POST /agent/search/parse` (permission `hotel.search`, same guards as search) runs the parser with the Asia/Dubai business date, resolves the destination text through the same typeahead, and returns the fields it found plus the ones it did not (`unresolved`). It never invents a value: a field it cannot read stays as the agent had it, and the UI says so.
- The pasted text is not stored, cached, audited or logged (it often contains guest names). Input is capped at 2,000 characters.
- An LLM (function calling) was deferred: it needs a secret, sends client emails to a third party and needs a redaction policy. It can be added later behind its own ADR as a fallback for `unresolved` fields.

**Client markup (display only).**
- The agent may set 0–50% (`0`–`5000` basis points, 0.01% steps) in the secondary bar. Search results and the hotel page show a *client price* next to the agency price, computed with `@bedbanks/pricing` `applyPercentMarkup` (BigInt, half-up). The markup is kept in session storage per user and tenant.
- It changes nothing the server sees: filters, sort, recheck, hold and booking use the agency's server price. The UI labels the two prices so an agent never quotes the agency price as the client price, or vice versa.

## Not built (do not present as capability, invariant 10)
- Regions and airport zones: the catalogue has only city and hotel. They need a reviewed migration (area model, hotel membership or radius, tenant indexes, RLS) and an admin screen; the typeahead does not show these kinds until then.
- Availability-aware calendar (greying out dates with no inventory): needs an availability-window endpoint; the calendar still enforces 1–30 nights and no past dates.
- Persisting the client markup on a booking, voucher or invoice: touches booking, finance and documents (idempotency, audit, ledger). Not done.
- LLM extraction (see above).
