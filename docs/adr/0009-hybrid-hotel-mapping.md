# 0009: Hybrid hotel mapping and short-lived search cache

## Status
Accepted.

## Decision
Supplier hotel candidates are ranked from normalized identity, trigram and token similarity, geographic distance, and a local hashed-token embedding stored in `HotelSearchIndex`. pgvector HNSW (`vector_cosine_ops`, 64 dimensions, model `fbeds-token-hash-v1`) retrieves neighbors. pg_trgm indexes the normalized name and address. A vector score cannot approve a mapping. Automatic mapping requires an approved supplier mapping, or one unambiguous candidate with country and city agreement plus address or close coordinates. Ambiguous candidates stay `REVIEW_REQUIRED`. Room candidates are limited to the chosen canonical hotel.

Agent search may cache a validated non-contracted discovery response for 15–45 seconds by default, bounded to 120 seconds, keyed by tenant and a hash of the normalized criteria including the page. Contracted inventory is not cached, so a stop-sell or rate edit is visible on the next search. Recheck, holds, prebook, booking, and finance are not cached. Cache and lock failures fall through to the authoritative search.

## Consequences
Stale discovery prices can appear until the TTL expires. Recheck reads current rates and stop-sell. Production PostgreSQL must have pgvector before this migration is applied there. The embedding provider can be replaced without changing the scoring rules, but the stored dimension stays 64 until a later migration.
