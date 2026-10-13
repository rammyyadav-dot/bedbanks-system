# CTO audit: API readiness for third-party XML suppliers (WebBeds, TBO, Darina)

Date: 2026-10-12. Branch `claude/vibrant-cori-8fpx3t`. Scope: `apps/api`, `packages/connectors`, connector-related Prisma models and docs.
Method: code and migration inspection plus `pnpm check:architecture`, type-check, lint and tests on the touched packages.
Supplier API facts (schemas, auth, limits) were **not** reviewed; none are asserted.

## Verdict

**Before this change: not connectable.** There was no XML transport, parser, secret resolution, connector
administration, inbound receiver or supplier booking adapter. Only a JSON Hotelbeds evaluation client existed, and it was not
reachable from any route.

**After this change: the shared, security-hardened XML foundation exists and is tested, but WebBeds, TBO and Darina are
still `NOT_IMPLEMENTED`.** Connecting them requires each supplier's specification and sandbox access (not in the repo) and
the platform gates below. No supplier can be searched or booked, and the code reports that honestly.

## What exists (verified)

| Area | Evidence | Assessment |
|---|---|---|
| Connector registry | `ConnectorDefinition`, `ConnectorCredentialReference`, `ConnectorExecution`, `InventoryUpdateEvent`; FORCE RLS in `202609190004_connector_registry_foundation` | Sound tenant model. Registry only; no runtime. |
| Canonical search port | `agent/supplier.port.ts` `SupplierAdapter`; sole binding is `ContractedInventoryAdapter` in `AgentModule` | Correct seam; unconfigured adapter returns empty, never fake inventory. |
| Booking supplier port | `booking-ops/supplier/booking-supplier.port.ts`; runner asks `statusByReference` after any throw | Excellent design for uncertain outcomes. `BookingSupplierRegistry.resolve` returns null for real tenants. |
| Mutation journal | `SupplierMutation` + `supplier-mutation-journal.service` (prebook) | Good; prebook idempotency key `booking:<id>:prebook`. |
| Hotelbeds sandbox | `connectors/core/src/hotelbeds-*.ts` | Careful, JSON only, single-process, not wired. |
| Architecture checks | `check:architecture` passes (contracts, no-float, no-silent-fallback, env, runtime role, AWS) | Green on this branch. |

## Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | Blocker | No XML capability: no parser, SOAP/XML transport, fault model | **Fixed**: `connectors/core/src/xml` (parser, transport, connector, types) |
| F2 | Blocker | No supplier adapter for the booking queue; registry resolves nothing | **Partly fixed**: `XmlBookingSupplier` translation rules + tests. Not wired (by design, see readiness) |
| F3 | Blocker | No secret resolver. `secretRef` is stored but nothing resolves it | **Open**: bind AWS Secrets Manager resolver (see `aws-secret-rotation-runbook.md`); transport already takes a `resolveSecret` port with 2 s timeout and no leakage |
| F4 | Blocker | Connectors cannot be created, activated or have credentials attached through the API; tables have no runtime write grant | **Open**: needs controller with a dedicated permission, audit event, maker-checker, contracts first (invariants 2, 4, 8), plus ADR for the runtime write set |
| F5 | High | Calls are not persisted: `ConnectorExecution` rows are never written; Admin connector view shows only seeded data | **Open**: transport emits sanitized `TransportEvent`; need a writer under a narrow DB role (ADR 0032 pattern) |
| F6 | High | Rate/circuit state is per process; credential quotas are shared | **Open**: `ConnectorGate` interface exists with in-process default; implement Redis gate on `COORDINATION_PORT` before more than one worker |
| F7 | High | Book port carries no guest data and no rate token; XML books need both | **Seam added** (`BookInputResolver`); **Open**: audited guest/rate-token store (encrypted, minimal, retention-limited) and prebook->book token continuity |
| F8 | High | Mapping: hotel/room codes from suppliers must come from governed mappings (ADR 0004/0009/0059); board mapping model absent (also noted in `supplier-sandbox-integration.md`) | **Open** |
| F9 | Medium | `GET /admin/.../connectors` requires `booking.read`; connector and credential-reference visibility is not a booking permission | **Open**: introduce `supply.connector.read` in the permission catalogue |
| F10 | Medium | No inbound webhook/push receiver. Some suppliers push booking or content changes | **Open**: needs signature verification, replay protection, `InventoryUpdateEvent` idempotency (table exists) |
| F11 | Medium | Static content sync only exists for Hotelbeds sandbox; XML suppliers need a content strategy | **Open**: per-supplier, after specs |
| F12 | Medium | Supplier cancellation penalties, tax inclusion and expiry must not be assumed | **Mitigated**: canonical type uses `null` for unstated expiry/tax and requires offset-qualified deadlines; commercial layer must treat null as a block |
| F13 | Low | Egress: SSRF defence via host allowlist and DNS check; DNS rebinding between check and connect cannot be fully closed in-process | **Open (infra)**: enforce supplier egress allowlist at the network layer (AWS security group / firewall), not just in code |
| F14 | Low | Node engine is 24.x; sandbox here is 22.x | Informational; checks passed on 22 |

## What the kit enforces (tested; 24 kit tests + 13 adapter tests, plus the 32 existing connector tests still green)

- XML: DOCTYPE/ENTITY/PI refused, depth/size/node/attribute budgets, strict UTF-8, no document fragments in errors; builder escapes all values and validates names.
- Transport: disabled by default; scope-locked to tenant/supplier/connector; endpoint from operator config only; redirects refused; private DNS answers refused; header injection refused; XML content type and UTF-8 only; response size cap; 2 s secret timeout; secrets never in errors or events.
- Retry rules: reads retry once, only on transient faults and short Retry-After; **mutations never retry** and report `delivery: maybe_sent`.
- Output: integer minor units via BigInt (`1e3`, `-1`, extra precision, zero rejected); currency, stay dates, hotel codes must match the request; duplicate tokens or bare local-time deadlines reject the entire response (no partial inventory).
- Readiness: `evaluateReadiness` gates searchability/bookability on nine conditions including PRODUCTION_CERTIFIED; unknown or unimplemented providers can never be sellable.

## Path to first live supplier (recommended order)

1. Choose the first supplier and obtain its spec + sandbox credentials (see `xml-supplier-onboarding.md`). WebBeds, TBO and Darina cannot be built in parallel without their documents; do one, then reuse.
2. Close F3, F4, F5 (secret resolver, connector admin API with permission and audit, execution persistence).
3. Close F8 and F7 (governed mappings, booking inputs) so offers can be canonical and bookable.
4. Write the profile and pass the supplier's sandbox script; record evidence; set `SANDBOX_CERTIFIED`.
5. Close F6 before running more than one worker; add the egress rule (F13).
6. Pilot on one tenant, search first, then book/cancel with the runner and daily supplier reconciliation; then `PRODUCTION_CERTIFIED`.

## Changes in this branch

- `packages/connectors/core/src/xml/*`, tests under `packages/connectors/core/test/`
- `apps/api/src/booking-ops/supplier/xml-booking-supplier.ts` (+ spec); `@bedbanks/connectors-core` dependency and path
- `ConnectorCapability` gains `'status'`
- ADR `docs/adr/0060-xml-supplier-connector-kit.md`; `docs/connectors/xml-supplier-onboarding.md`
- No migration, no route, no runtime behaviour change.
