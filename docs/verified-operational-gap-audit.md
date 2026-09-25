# Verified operational gap audit

Baseline: `265fd7366b7ffeb0c098f33f8200998b530be901` (`main`, merged PR #82).

This audit distinguishes current production risks from future architecture work. It does not certify a deployment or a persistent database.

| Finding | Status | Evidence | Impact and action |
| --- | --- | --- | --- |
| Live supplier connector | BLOCKED BY EXTERNAL DEPENDENCY | `apps/api/src/agent/agent.module.ts` binds `UnconfiguredSupplierAdapter`; connector registry documentation explicitly says no transport is implemented. | Agent Search correctly returns unavailable. Do not invent Darina endpoints or payloads. Obtain approved API documentation, sandbox access and a secret-manager reference before implementing the first adapter. |
| Canonical search filters and result bound | VERIFIED, FIXED HERE | PR #82 validated filters but did not apply them to normalized offers. | The domain boundary now enforces canonical hotel, destination, star, board, refundable, price, positive availability and result-limit constraints. |
| Agent mock fallback | NOT SUBSTANTIATED | `apps/agent/services/hotel-service.ts` permits demo inventory only with an explicit flag outside production and never substitutes it after a failed live call. | Preserve the existing fail-closed behavior and tests. |
| Admin mock operational data | VERIFIED | `apps/admin/lib/data/index.ts` and several routes still consume `apps/admin/lib/mock`. | These screens are not production-authoritative. Replace them endpoint-by-endpoint with real authenticated APIs; until then they must remain visibly demonstrational and must not be used for operational decisions. |
| Supplier mock operational data | PARTIAL | Presentation routes use a labelled mock adapter; inventory and profile routes use `SupplyWorkflowUnavailable`. | Retain honest unavailable states. Replace presentation data only when authenticated supplier APIs exist. |
| Embedded JWT/cookie/database secrets | NOT SUBSTANTIATED | Authentication uses opaque database sessions; connector records store secret references. CI database URLs target disposable PostgreSQL. | Continue startup validation and redaction. Deployment secret-manager ownership remains an operations certification item. |
| Distributed Redis lock | DEFERRED | Booking, prebook, cancellation and inventory deduction remain disabled. | Design database transactions, conditional inventory updates and idempotency before selecting a distributed lock. Redis is not part of this milestone. |
| Commercial edge-case coverage | PARTIAL | Existing unit, API E2E, tenancy and migration checks are present; live connector and advanced commercial cases cannot be certified without a real adapter. | Add provider contract tests with the first approved supplier and expand tax, markup and cancellation cases without floating-point arithmetic. |

## External evidence required for the first Darina adapter

1. Approved Darina Holidays API specification and version.
2. Sandbox base URL and network allowlist requirements.
3. Sandbox account represented only by an approved secret-manager reference.
4. Search, availability, board, cancellation, tax and error-code samples.
5. Supplier hotel and room identifiers for mapping certification.
6. Timeout, rate-limit and support/escalation expectations.

Until these items exist, connector status is `UNCONFIGURED`; provider-unavailable responses are the correct behavior.
