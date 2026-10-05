# Hotelbeds sandbox integration — transport slice

## Status and scope

This is a disabled-by-default, operator-only Hotelbeds evaluation transport and
staging slice. It is **not a certified supplier integration** and is not connected
to Agent search, mapping writes, inventory writes, booking or payment.

Base: `9a05688203511e5b0ce1764d9384662ab7fa3674`.
Base tree: `09e2d2b53d2d2ae056c56858ee88e910b065dc65`.
Branch: `feat/supplier-sandbox-integration`.
Node: v24.19.0; package manager: pnpm 10.4.1 through Corepack.
The checkout was clean before creating an isolated worktree.

F01 remains OPEN. Its candidate remains
`aea042299bdc2b7fbc33945b0cb89ba0a7a04238`. This change makes no F01 claim.

## Supplier selection and official contract

Hotelbeds was selected because public official documentation identifies its
test host, authentication, availability/checkrates workflow and content paging.
No Hotelbeds/TBO/WebBeds credential variable names were present in the execution
environment. No credential values or connection strings were read or printed.

Official sources, accessed 2026-10-05:
- Getting started: https://developer.hotelbeds.com/documentation/getting-started/
- Booking API overview: https://developer.hotelbeds.com/documentation/hotels/booking-api/
- Workflow: https://developer.hotelbeds.com/documentation/hotels/booking-api/workflow/
- Best practices: https://developer.hotelbeds.com/documentation/hotels/knowledge-base/best-practices/
- Content usage: https://developer.hotelbeds.com/documentation/hotels/content-api/how-use-content-api/

Version 1.0 appears in the documented request paths; no undocumented schema
version is asserted. Interactive API-reference pages did not expose a complete
machine-readable specification through the browsing tool. This implementation
therefore deliberately supports a narrow documented workflow, not all options.

Important supplier constraints:
- Official guidance advises against using evaluation/pre-production hotel
  mappings. Consequently sandbox content cannot populate canonical mappings.
- CheckRates should not run indiscriminately for BOOKABLE rates.
- Content belongs in a periodic batch, not the real-time Agent search path.
- Registration evaluation credentials have a documented limited daily quota.
  A 403 may represent authentication or exhausted quota, so it is not silently
  interpreted as an invalid password.

## Gap matrix

| Requirement | Existing evidence | This change | Remaining gate |
|---|---|---|---|
| Transport | Connector core previously exposes capability/health interfaces only | Fixed-host signed JSON status/search/checkrates/content client | Real credentials and provider execution |
| Hotel/room mappings | MappingService authorization, audit, MAPPED decisions and scoped relationships | Reused design boundary; no sandbox mapping mutations | Approved non-test mapping source/account entitlement |
| Board mapping | Canonical BoardBasis exists; supplier board mapping model not found | Board codes retained as supplier observations | Governed supplier-board relationship design |
| Canonical search | ContractedInventoryAdapter currently bound in AgentModule | Binding preserved | Approved identities, occupancy/market contract, commercial authority |
| Recheck | Existing canonical authority requires ratePlanId, sell amount and expiry | Documented supplier CheckRates request available only for RECHECK observations | No invented expiry or canonical authority |
| Synchronization | Registry/execution/event foundations; coordination port | Bounded staged page runner with resume/store contract | Durable atomic store, fencing and database certification |
| Recovery | Existing cache/coordination foundations | Classified errors, one safe-GET retry, circuit and evaluation limits | Shared credential-wide multi-process quota/circuit coordinator |
| Visibility | Existing Admin connector views read registry/executions | Sanitized transport events and operator output | Authorized persistent execution/status integration |

No parallel approval system, mapping manifest, synthetic canonical IDs or new
inventory counter is introduced.

## Transport boundary and allowlist

The only outgoing host is `https://api.test.hotelbeds.com`. Configuration has no
base-URL field. Redirects are refused. The request function validates the
operation/path/method even if invoked through an unsafe runtime cast.

| Operation | Method and path | Boundary |
|---|---|---|
| status | GET /hotel-api/1.0/status | JSON response received is not full health certification |
| search | POST /hotel-api/1.0/hotels | 1 room, 2 adults, no children, 1–10 distinct hotel codes |
| checkrates | POST /hotel-api/1.0/checkrates | One RECHECK rate key |
| content | GET /hotel-content-api/1.0/hotels | ENG/all fields; 1–100 rows per page; optional validated update date |

Bookings, prebooking, booking queries, confirmation, cancellation, payments,
production hosts, arbitrary URLs and other operations are not exposed.
This slice has no XML parser.

Authentication uses server-side API-key/signature headers. Secrets are resolved
from a reference scoped to a fixed tenant/supplier/connector. No header, raw
response, supplier rate key or secret is emitted by telemetry.

Controls:
- Explicit boolean enablement; caller scope equality.
- One active request per transport instance.
- Five-second attempt timeout; ten-second overall retry budget.
- Two-second secret-resolution timeout.
- Maximum decoded JSON size 2 MiB; strict UTF-8 and MIME handling.
- Local one-request-per-second pacing and 50-attempt UTC-day ceiling.
- Cancellation propagation and no POST automatic retry.
- GET retry at most once for transient failures; jittered delay.
- Retry-After respected; an excessive delay stops rather than retrying early.
- Circuit opens after three failed attempts for 30 seconds.
- Sanitized classifications rather than raw upstream exception messages.

The rate budget/circuit are **single-process only**, and reset on process
restart. They do not coordinate multiple instances or account for requests from
another client sharing the credential. Do not deploy this client as a worker
fleet or enable Agent routing until shared atomic controls exist.

## Normalization and commercial safety

`normalizeHotelbedsResponse` returns server-side staging observations, not
SearchRateOffer or RecheckedOfferAuthority.

AED decimal strings convert through integer/BigInt arithmetic. Numeric wire
prices, zero/negative values, unsupported precision and unsafe integers fail.
No FX occurs. Supplier hotel/room/board codes and rate keys remain references.

This slice rejects unsupported occupancy, payment/packaging and unknown rate
types. Cancellation policies are preserved with offset-qualified timestamps.
Unknown or exclusive tax metadata is explicitly flagged. Supplier net is not
presented as the final marked-up fBeds sell price.

Every observation is non-selectable. There is no supplier timestamp/expiry
fabrication: receivedAt is local receipt, while supplierUpdatedAt and
supplierExpiresAt are null. Missing expiry and commercial authority are explicit
block reasons. No observed stock/allotment value is written to local inventory.

A fresh supplier HTTP response alone does not grant Agent sellability.
The canonical contract's rate-plan, sell-price, approved mappings and expiry
requirements must be resolved before routing.

## Synchronization, provenance and recovery

`syncHotelbedsContent` is explicitly invoked, bounded to five pages and requires
a real lease. NoopCoordination returns no lease and cannot run the job.

The supplied store must:
1. Bind run ID to its update-date parameters and tenant/supplier/connector scope.
2. Verify a fencing/lease token at commit.
3. Compare-and-swap expected checkpoint.
4. Stage page content and advance checkpoint atomically.
5. Preserve receipt as receipt, not supplier freshness.
6. Provide durable replay/resume and authorized audit.

The implementation refuses malformed pagination and duplicate identities within
a page. Failed pages do not advance checkpoints. It stops before the lease
safety window. A partial page never implies deletion. It does not approve,
overwrite or deactivate canonical mappings.

**No production/durable store implementation is supplied here.** Tests use an
explicit fixture store. This is not PostgreSQL synchronization certification.
No dynamic rate/availability synchronization is implemented because the selected
public contract does not establish a complete stock feed for this account.

## SQL/RLS and principal decision

Actual SQL introduced by this slice: **none**. No schema/grant migration,
persistent role provisioning or database connection is introduced.

Existing MappingService enforces permissions and wraps mapping decisions plus
audit in tenant transactions. Existing canonical BoardBasis cannot be treated as
an approved supplier-board relationship merely because labels match.

ConnectorDefinition/ConnectorExecution/InventoryUpdateEvent exist, but the
runtime-role contract does not list them. Their presence is not permission for
ordinary API writes. Do not widen the role to persist this slice.

For a future durable store:
- Compare narrow staging/execution rights on the current API role with an
  independently scoped synchronization principal.
- Derive exact SELECT/INSERT/UPDATE/sequence requirements from its implemented
  statements and RLS policies; do not copy broad grants.
- Protect canonical mappings/stock and supplier-mutation tables.
- Use forced RLS and non-owner/non-superuser/non-BYPASSRLS certification.
- A separate principal is a candidate design, not an approved requirement.
- A forward migration is reviewable only after the complete statement/policy
  matrix and disposable replay/upgrade evidence exist.

## Operator evaluation

No network request runs on import. Use an explicitly approved sandbox account
and server-side secret injection; never paste credentials into command history.

Required variable names:
- HOTELBEDS_SANDBOX_ENABLED (exactly true)
- HOTELBEDS_SANDBOX_API_KEY
- HOTELBEDS_SANDBOX_SECRET
- FBEDS_SANDBOX_TENANT_ID
- FBEDS_SANDBOX_SUPPLIER_ID
- FBEDS_SANDBOX_CONNECTOR_ID

For search-recheck also:
- HOTELBEDS_SANDBOX_TEST_HOTEL_CODE (supplier-approved test property)
- FBEDS_SANDBOX_CHECK_IN
- FBEDS_SANDBOX_CHECK_OUT

Commands:
```sh
node tools/hotelbeds-sandbox-evaluate.mjs status
node tools/hotelbeds-sandbox-evaluate.mjs search-recheck
node tools/hotelbeds-sandbox-evaluate.mjs content
```

The search-recheck command retains tokens in memory, returns sanitized counts,
and only rechecks the first RECHECK observation. It does not emit tokens or
establish Agent authority. Content evaluation counts records and writes nothing.
The CLI is not an authenticated application endpoint; OS/operator access must
control its execution and secret environment.

Running status without configuration failed closed with exit 1 and
SANDBOX_ACCESS=BLOCKED. No supplier request was made.

## Validation evidence

Independent Node tests cover transport contracts, fake upstream failures,
normalization and fixture checkpoint replay. They are labelled FIXTURE and
FAILURE_INJECTION; they cannot prove real provider connectivity.

Commands and final validation results are recorded in the PR. Initial install
temporarily lacked the compiler; offline lockfile resolution lacked cache
metadata. These are setup failures, not successful validation evidence.

Final checks on this slice (Node 24.19.0, pnpm 10.4.1):
- Connector package type-check: PASS.
- Connector package lint: PASS.
- Connector package production TypeScript build: PASS.
- Compiled package export import: PASS.
- Architecture guards: PASS.
- Connector tests: 31 PASS, zero failed/skipped (fixtures/failure injection only).
- Frozen-lockfile offline install: PASS after dependency installation.
- Operator command without credentials: expected exit 1, no network request.

The default shell pnpm is 11.25.0. Corepack selects 10.4.1; a scratch-only
PATH shim also selects that version for nested repository scripts. No project
toolchain version was changed. Full API/Agent regression and database tests
were not rerun: no API/domain/Agent binding or SQL changed in this slice.

No database acceptance or live supplier request ran. Existing contracted Agent
routing and safety gates are unchanged. No hosted Agent MVP claim is made.

## Remaining blockers

- Approved supplier sandbox credentials and approved test property.
- Complete account-specific contract for nationality/market and supported
  occupancy.
- Supplier-approved mapping source independent of test content.
- Governed supplier-board mapping.
- Commercial sell-price authority and expiry/invalidation policy.
- Durable staged synchronization and execution/audit persistence.
- Shared atomic credential quota/circuit controls before multi-worker use.
- Disposable PostgreSQL strict-role acceptance for eventual SQL changes.
- Real sandbox search/recheck/sync/error-recovery evidence.

These blockers prevent full certification; this draft is an independently
testable transport/staging slice, not completion of all mission gates.

## Gates

```text
SUPPLIER_SELECTED=HOTELBEDS
OFFICIAL_API_CONTRACT=DOCUMENTED_NARROW_V1_0_SLICE
SANDBOX_ACCESS=BLOCKED_NO_CREDENTIALS
REAL_SANDBOX_TRANSPORT=NOT_PERFORMED
PRODUCTION_HOSTS_DENIED=IMPLEMENTED_AND_FIXTURE_TESTED
UNSAFE_OPERATIONS_DENIED=IMPLEMENTED_AND_FIXTURE_TESTED
CANONICAL_NORMALIZATION=BLOCKED_STAGING_ONLY
APPROVED_HOTEL_MAPPING=BLOCKED_SUPPLIER_MAPPING_POLICY
APPROVED_ROOM_MAPPING=BLOCKED_SUPPLIER_MAPPING_POLICY
APPROVED_BOARD_MAPPING=NOT_IMPLEMENTED
REAL_SANDBOX_SEARCH=NOT_PERFORMED
REAL_SANDBOX_RECHECK=NOT_PERFORMED
QUOTE_EXPIRY_HANDLING=FAIL_CLOSED_NO_EXPIRY_INVENTED
TAX_FEE_PRICE_INTEGRITY=NON_SELECTABLE_STAGING
SYNC_IDEMPOTENCY=FIXTURE_CHECKPOINT_TESTED_DURABLE_STORE_PENDING
SYNC_RESUME=FIXTURE_TESTED
PROVENANCE_PRESERVED=NO_CANONICAL_OR_INVENTORY_WRITES
STALE_DATA_FAIL_CLOSED=NO_STALE_DATA_PROMOTION
ERROR_RECOVERY=BOUNDED_SINGLE_PROCESS_FIXTURE_TESTED
TENANT_ISOLATION=TRANSPORT_SCOPE_TESTED_DATABASE_CERTIFICATION_PENDING
STRICT_ROLE_VALIDATION=NOT_PERFORMED_NO_SQL_INTRODUCED
REAL_SANDBOX_CERTIFICATION=BLOCKED
F01_STATUS=OPEN
PRODUCTION_DB_MIGRATION_EXECUTED=NO
PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO
PRODUCTION_DEPLOYMENT_EXECUTED=NO
DNS_OR_ALIAS_CHANGED=NO
LIVE_SUPPLIER_ENABLED=NO
LIVE_SUPPLIER_AUTHORIZED=NO
BOOKING_ENABLED_BY_THIS_WORK=NO
LIVE_BOOKING_AUTHORIZED=NO
PAYMENT_ENABLED_BY_THIS_WORK=NO
LIVE_PAYMENT_AUTHORIZED=NO
```
