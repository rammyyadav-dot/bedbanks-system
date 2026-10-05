# Pool capacity editor and per-plan consumption

Decision record: [ADR 0036](adr/0036-pool-capacity-editor-and-per-plan-consumption.md). Where: **Hotels > a hotel > Inventory & Allotment > Open this pool**.

## Counter definitions
| Term | Meaning |
| --- | --- |
| capacity | Rooms the pool offers on a night (`InventoryPoolDay.capacity`) |
| held | Units on holds in HELD, PROCESSING or HOLD_PENDING |
| sold | Units on holds in CONFIRMED |
| available | `capacity - sold - held`, subtracted once (what search and recheck use) |
| unattributed | `counter - sum(attributed to plans)`; negative = inconsistent, shown as is |

Not counted: RELEASED, EXPIRED, FAILED, PENDING_RECHECK, RECHECKED holds. Missing pool nights are unknown, not zero.

## Reconciliation formula
For each night with a pool row: `held = sum(plan.held) + unattributedHeld` and `sold = sum(plan.sold) + unattributedSold`. The report's totals are the sums of the nights shown; `inconsistentNights` counts nights where either unattributed figure is negative.

## Capacity edit invariants
1. Blank capacity is refused (unchanged); zero is a value; negative, fractional, > 9999 or non-numeric is rejected, never clamped.
2. `capacity >= sold + held` on every edited night, checked at preview, again at apply, and by the guarded `UPDATE` at write time.
3. Nights before the hotel-local today cannot be edited; at most 366 nights per edit.
3a. Only nights that already have a pool stock row can be edited. A night without one is `INVALID` and is never created by this editor (the strict runtime role holds no INSERT; pool authoring stays a privileged path).
4. Holds, sold units and consumption are never removed or altered. Prices, modes, restrictions, plan rows and booking state are untouched.
5. The tenant, hotel and pool are verified server-side; the tenant comes only from the session.
6. All nights change in one transaction or none do.

## Concurrency and stale previews
The preview returns a fingerprint of the request, the pool status and each selected night (capacity, sold, held, version, or absence). Apply recomputes it under the per-hotel advisory locks and refuses with `409 POOL_CAPACITY_STALE` if anything differs, including consumption that arrived after the preview. Two applies from one preview: exactly one wins. A decrease racing with new holds can never breach `sold + held <= capacity`; one side always yields. An idempotency key makes a retry safe: the same key and request replays the first result; the same key with another request is `409 IDEMPOTENCY_KEY_REUSED`.

## Permission matrix
| Capability | Permission | Without it |
| --- | --- | --- |
| View pool and consumption | `supply.availability.read` | 403 |
| Preview an edit (no write) | `supply.pool_capacity.preview` | 403 |
| Apply an edit | `supply.pool_capacity.apply` | 403 |
| Hotel audit trail | `audit.read` | link not shown |

The migration grants these to no role; assign them to roles explicitly. The editor works on the strict API database role (ADR 0036, Amendment 1; contract in [strict-runtime-db-role.md](strict-runtime-db-role.md)): a capacity-only column `UPDATE` on `InventoryPoolDay` and column-level reads of the hold tables. Application permissions still decide who may apply; a statement outside the role's contract is `403 RUNTIME_ROLE_OPERATION_PROHIBITED`; a missing contract privilege (drift) is a sanitized `503 DATABASE_ROLE_NOT_PERMITTED`, never an `unavailable` attribution or a zero. Those migrations and persistent provisioning are owner-controlled steps.

## Audit events
`inventory.pool.capacity_changed` on the hotel (entity type `hotel`), payload: `poolId`, `poolName`, `startDate`, `endDate`, `weekdays`, `capacity`, `reason`, `changed {updated}`, `idempotencyKey`, `requestHash`, `requestId`, `fingerprintBefore`, `fingerprintAfter`, `sample` (up to 20 nights, from and to). Permission denials are the existing `permission.denied`.

## Historical attribution limitations
Attribution reads each hold's recorded pool night and plan, so history survives membership changes. Consumption written before holds recorded a counter, or written to the counter outside the hold path, can only be shown as unattributed. Nights a plan sold on its own row before pooling are not part of the pool. The report is bounded to 62 nights.

## Operator workflow
1. Open the pool; check the window, the daily counters and who holds what.
2. Enter start and end dates, optional weekdays and the new capacity; **Preview**. Read the before/after table and any INVALID nights (units already sold or held).
3. Enter a reason and **Apply exactly this change**.
4. **If you see "changed after you previewed it"**, nothing was written: another edit or new bookings touched those nights. Press **Preview again**, check the new before values and apply again.
5. **If the apply says it could not reach the server**, press Apply again without changing anything: the same idempotency key is reused, so it is applied once.
6. To undo a change, preview and apply the previous capacity; the audit trail keeps both events.

## Verification
- `pool-capacity-rules.spec.ts`: 16 unit tests (validation, planning, fingerprint, attribution).
- `pool-capacity-editor.e2e-spec.ts`: 27 PostgreSQL/HTTP tests with two tenants, the real hold lifecycle and the Agent adapter. PCE-22 to PCE-27 boot the real API on the provisioned non-superuser, non-BYPASSRLS, non-owner login and prove Apply, reconciling attribution, 403/409/422/503 semantics, direct-SQL denials of protected and ungranted columns, tenant isolation, verifier drift detection and concurrent integrity.
- `tools/admin-ops-verify/verify-pool-capacity.cjs`: 59 Chromium checks on the production Admin build, run against an API connected as the strict login (provision the role with `ops:provision-api-runtime-role`, start the API with that login URL, as in the Hotel setup journey section of `tools/admin-ops-verify/README.md`). Run `seed-pool-capacity.ts` first with the owner URL (re-seed before each run: the run edits capacity).


### Freshness safety (ADR 0037)

Capacity changes preserve source, source_updated_at, received_at and fresh_until. Expired supplier nights stay expired; missing nights stay unknown. The API role updates only capacity and updated_at, never provenance. Quick Update statements that stamp provenance remain privileged. The forward migration 202610270001_strict_runtime_role_pool_freshness clears prior column grants before applying the narrower contract.
