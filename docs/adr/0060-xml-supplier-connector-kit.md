# ADR 0060: Shared XML supplier connector kit

Status: Accepted (foundation only; no supplier is live)
Date: 2026-10-12

## Context

fBeds must connect to third-party XML suppliers (WebBeds, TBO, Darina and later ones). The repository had a registry
(`ConnectorDefinition`, credential references, executions), a canonical `SupplierAdapter` search port and a
`BookingSupplierPort` for the Admin booking queue, but no XML capability at all, no secret resolver, no way to
create or activate a connector through the API, no inbound webhook receiver, and one JSON-only Hotelbeds evaluation
client in `@bedbanks/connectors-core`. Writing each supplier from scratch would copy the same security and
failure-handling decisions three times, and a mistake in one would not be caught by the others.

## Decision

1. All supplier XML/SOAP transport lives in `@bedbanks/connectors-core/src/xml`. A provider is a *profile*: request
   builders, response mappers and a fault classifier (`XmlProviderProfile`). Everything else is shared and cannot be
   weakened per supplier: hardened parser, endpoint policy, timeouts, size limits, retry rules, circuit/concurrency
   gate, error taxonomy, canonical output invariants.
2. The XML parser is in-repo and refuses DOCTYPE/ENTITY/processing instructions, so XXE and entity expansion are
   impossible by construction. Money is parsed from decimal strings with `@bedbanks/money` (BigInt, no floats).
3. The endpoint is operator configuration validated against an exact host allowlist (https, no userinfo, port 443, no
   IP literals, DNS answer must be public, redirects refused). Tenant data never selects a URL.
4. **Mutations (book, cancel) are never retried by the transport.** Every failure carries a `delivery` state
   (`not_sent` | `maybe_sent` | `answered`). The API adapter (`XmlBookingSupplier`) turns only a definite supplier
   refusal into `REJECTED`; every uncertain outcome throws so the existing runner resolves it with
   `statusByReference` before concluding anything (no ghost bookings, no duplicates).
5. Supplier output is canonical *observation* data. It carries `supplierExpiresAt: null` and
   `taxesIncluded: null` when the supplier does not say so; it is never sell price and never selectable until mapping,
   commercial rules and a recheck with a real expiry apply.
6. A supplier is searchable/bookable only when `evaluateReadiness` passes every gate, including `PRODUCTION_CERTIFIED`.
   `webbeds`, `tbo` and `darina` are `NOT_IMPLEMENTED` and no profile is registered for them. Fixtures use a synthetic
   supplier that is never registered.

## Consequences

- Adding a supplier is a profile + fixtures + conformance run, not new transport code.
- The kit does not by itself make any supplier work. The remaining platform gates (secret resolver, connector admin
  API, execution persistence, shared gate, governed mappings, book inputs) are listed in
  `docs/connectors/xml-supplier-api-audit-2026-10-12.md` and must be closed before the first profile is enabled.
- The in-process gate is single-process. A shared gate (Redis `COORDINATION_PORT`) is a go-live prerequisite for any
  deployment with more than one worker.
- `BookingSupplierRegistry` is intentionally not changed. Wiring happens per supplier, behind the readiness report.

## Rollback

The kit is additive and unwired. Removing `packages/connectors/core/src/xml`, `xml-booking-supplier.ts` and the
`@bedbanks/connectors-core` path/dependency restores the previous state. No migration is included.
