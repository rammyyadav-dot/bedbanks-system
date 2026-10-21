# ADR 0077: Supplier and channel-manager ingestion normalization core

Status: Accepted (normalization core only; no supplier feed is wired or live)
Date: 2026-10-21

## Context
ADR 0060 gave search/book/cancel XML transport and canonical *offers*. Nothing normalized the bulk data upstream
sources push or publish: per-night rates, allotments and cancellation policies, in XML (hotel suppliers) or JSON
(channel managers). Without one normalizer, each provider would re-decide how to read money, dates, zero stock and
"no policy", which is exactly where mis-sold or phantom inventory comes from.

## Decision
`@bedbanks/connectors-core/src/ingest` is transport-agnostic and does no I/O. It has two stages.

1. **Extract** (`extractXmlRecords`, `extractJsonRecords`): a declarative `ExtractionSpec` (record path plus field map,
   with parent-level fields) turns a document into flat string records. XML goes through the hardened parser (no
   DOCTYPE/entities). JSON paths refuse `__proto__`/`constructor`/`prototype`. A wrong shape throws `IngestShapeError`
   with no payload fragment. A provider is therefore a spec, not new parsing code.
2. **Normalize** (`normalizeRates`, `normalizeAllotments`, `normalizeCancellationPolicies`): one validator for every
   provider, producing canonical `IngestRate`, `IngestAllotment`, `IngestCancellationPolicy`.

Rules, all failing closed:
- Money: decimal string to integer minor units via `@bedbanks/money` (BigInt). Zero, negative, over-scale and exponent
  values are rejected (ADR 0034). A JSON number is accepted only if its text is a plain decimal; suppliers should send strings.
  Percentages are integer basis points (0..10000). Fixed penalties carry their currency.
- Dates: ISO calendar dates within `[today, today + horizonDays]` (default 800). Cancellation instants must be offset-qualified;
  a bare local time is rejected. "N days before arrival" rules resolve only with an operator-configured hotel UTC offset and
  cut-off time; there is no default, so a feed needing one without it is rejected.
- Allotments (ADR 0030 #4): a missing or negative count is rejected, never read as zero or unlimited. Free sale, on request
  and closed must be stated. Stop-sell and release days are carried as stated.
- Taxes: unstated `taxesIncluded` stays `null` (a downstream block reason).
- Cancellation: windows are sorted and strictly increasing; a non-refundable plan may contain only `FULL` windows; a plan with
  no usable windows, contradictory refundability or duplicate start instants is rejected as a whole.
- Duplicates: identical rows collapse; contradictory rows for one key are both rejected.
- Observability (invariants 5, 7): every reject is `{kind, index, code, field}` with canonical field names only. Each result
  has a `status`: `COMPLETE`, `PARTIAL`, or `FAILED` (nothing accepted, empty feed, or rejects above `maxRejectBasisPoints`,
  default 5000). Callers must not replace existing inventory from a non-`COMPLETE` result without an explicit policy.

## Not built (invariant 10: do not present as capability)
- Nothing calls this module. No scheduler, webhook receiver, persistence, supplier-observation tables, mapping of supplier
  hotel/room/plan codes to canonical ones, or freshness stamping (`freshUntil`, ADR 0030 #7). Those need a reviewed
  migration, tenant indexes, RLS, idempotent ingestion runs and audit events, and their own ADR.
- No real provider spec is registered. Tests use synthetic, unregistered fixtures.
- Board code is carried as the supplier sent it; canonical board normalization lives in `apps/api/src/mapping` and is applied
  by the API at the mapping boundary.
- Percent and nights penalties are carried, not priced; resolving them to minor units needs the stay price at quote time.

## Rollback
Additive. Remove `packages/connectors/core/src/ingest`, its export line in `src/index.ts` and `test/ingest.test.mjs`. No
migration, permission or route.
