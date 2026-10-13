# ADR 0064: Persistent Redis connection, static-content cache-aside, and mapping pipeline core

Status: Accepted. Partly implemented; the "Not built" section is the honest boundary of what this change delivers.

## Context
ADR 0009 already caches non-contracted discovery search for 15-45 s (tenant-keyed, single-flight, fail-open). Two gaps remained for high-concurrency operation:

1. `RedisCacheAdapter` opened a new TCP/TLS connection and re-ran AUTH and SELECT for **every** command, so each cache hit paid a handshake plus three round trips. On ElastiCache (TLS + AUTH) that cost, not Redis, is the latency floor.
2. Static content (facets, destinations, hotel content) had no cache, and the mapping code (`hybrid-match`) was a library nothing called: no board-basis or amenity normalization, no strict-identifier layer, no routing into auto-map / review / unmatched.

## Decision
**Cache**
- `RedisCacheAdapter` keeps one lazily-opened, authenticated connection per process and pipelines commands on it. A command timeout, socket error or protocol fault destroys the connection (reply order is no longer trustworthy); the next command reconnects and re-authenticates. The socket is `unref()`'d. `close()` is provided. The `CachePort`/`CoordinationPort` interfaces are unchanged.
- `CacheAside` (`common/cache`) is the reader for **static, non-authoritative** content: single-flight per key, jittered TTL, shape validation (`accept`), hit/miss/fault/coalesced counters. Policy (invariant 5): a *cache* fault falls through to the authoritative loader; a *loader* fault propagates and is never cached; `null` is never cached. It must not be used for rates, availability, wallet, booking or any value that authorizes an allocation.
- First consumer: `DestinationResolverService.facets` (60 s TTL, key `fbeds:v1:<tenant>:agent-facets:all`, tenant from the authenticated context only).

**Mapping core** (`apps/api/src/mapping`, transport-agnostic, no I/O)
- `attributes.ts`: canonical board basis (RO/BB/HB/FB/AI), amenity codes, phone (international vs national evidence), postal and registry-code normalizers. Unknown or contradictory input returns `null` and is routed to review; it is never guessed. Unmapped amenities are returned, not dropped.
- `deterministic-match.ts`: registry code, international phone and postal+100 m rules. A match requires exactly one qualifying canonical hotel, the same country, and a non-contradictory name. A shared identifier on an unrelated name is a `CONFLICT`, and several hits are `AMBIGUOUS`; both go to a person.
- `mapping-pipeline.ts`: routes each supplier record to `AUTO_MAP`, `REVIEW_QUEUE` or `UNMATCHED` (known mapping, then deterministic, then the existing hybrid probabilistic matcher). Two supplier records claiming one canonical hotel are both demoted to review (ADR 0004).
- Room matching ignores filler words ("room"), so "King Deluxe Room" = "Deluxe King"; a room-class mismatch (Suite vs Deluxe) is `NO_MATCH`.
- Thresholds are unchanged from ADR 0009: auto-map needs score >= 92 with supporting evidence, and the review band starts at 70. This is deliberately stricter than "70-85 reviewed, above 85 automatic": a wrong auto-map sells the wrong room.

## Not built (do not present as capability, invariant 10)
- The pipeline is **not wired** to ingestion, the database or `MappingService`. Supplier mappings carry only ids today, so there is no supplier-catalogue snapshot to feed it; that needs a reviewed migration (supplier hotel observation table, tenant indexes, RLS) and its own ADR.
- No review-queue endpoint, contract in `@bedbanks/contracts`, or `apps/admin` screen yet. `reviewQueueOrder` only defines the ordering.
- Phone and registry code are not yet stored on `Hotel`, so the strong-identifier layer has nothing to compare against in production until the schema carries them.
- Redis hit/miss counters exist in-process; nothing exports them to observability yet.
- Invalidation is TTL-based (facets); no write-path invalidation exists.

## Operations
`REDIS_URL` is unchanged. With no Redis configured the NoopCache is used and every read hits the database. A Redis outage costs latency only. One connection per API process; size ElastiCache for connections = tasks, not requests.

## Rollback
Revert the commit. No schema or data change, no new permission, no new route.

## Verification
Unit: attributes, deterministic layer, pipeline, CacheAside, adapter handshake/reuse/reconnect/timeout against an in-process RESP server, facets cache. Integration: `redis-cache.adapter.spec.ts` against a real `redis-server`. Loopback microbenchmark (no TLS/AUTH/network, so indicative only): 0.37 -> 0.14 ms/GET sequential, 0.24 -> 0.03 ms/GET with 2000 concurrent GETs.
`pnpm check:architecture` passes. `tsc` and 5 jest suites already fail on the base commit (`booking-persistence.service.ts` declares `plan` twice); they are unchanged by this work.
