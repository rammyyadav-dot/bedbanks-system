# ADR 0036: Pool capacity editor and per-plan consumption report

## Status
Accepted for the API code, Admin UI and tests in this change. No schema change. One data-only forward migration, `202610250001_pool_capacity_permissions`, adds two rows to the global `Permission` catalogue (replayed only on disposable local databases; applying it to a persistent database is an owner-controlled step). Sections 3 and 6 are **amended** by the strict-runtime-role follow-up (see "Amendment 1" at the end): capacity edits only touch existing nights, and the strict API role gets a capacity-only column UPDATE and a column-level attribution read through forward migration `202610260001_strict_runtime_role_pool_capacity`.

## Context
ADR 0030 gave shared pools one authoritative counter set (`InventoryPoolDay`: capacity, sold, held) and left two things open: a dedicated way to edit pool capacity, and "per-plan consumption reporting inside a pool". Capacity could only be changed through Quick Update, which edits plans and weekdays together and has no view of who consumed the pool.

## Decision

### 1. Counter definitions (nothing new is counted)
For a pool night: `available = capacity - sold - held`, computed once (the evaluator, search and recheck use the same expression). The database enforces `sold + held <= capacity`. A missing pool row is unknown, never zero. This work adds no counter and never writes `sold` or `held`.

### 2. Per-plan attribution comes from what each hold recorded
A hold records, when it reserves, the pool night it drew from (`InventoryHoldNight.poolDayId`, counter kind `POOL_DAY`) and the plan that holds it (`InventoryHold.ratePlanId`, fixed at creation). The report groups those records by plan and by the hold's *current* status:

| Hold status | Counts toward |
| --- | --- |
| `HOLD_PENDING`, `HELD`, `PROCESSING` | held |
| `CONFIRMED` | sold |
| `RELEASED`, `EXPIRED`, `FAILED`, `PENDING_RECHECK`, `RECHECKED` | nothing (units were returned or never taken) |

A cancelled booking returns its units and its hold becomes `RELEASED`, so it counts nowhere. Cumulative lifecycle events are never shown as occupancy.

**Reconciliation:** per night, `counter = sum(attributed plans) + unattributed`. The unattributed part is derived (`counter - attributed`), never fabricated. A negative value means holds claim more than the counter holds; the night is reported `INCONSISTENT` with the figure and is not corrected. Current pool membership is never an input, so a plan that left the pool keeps its history and is listed as a former member.

**Limitations (stated in the report):** consumption recorded before holds noted their counter (before ADR 0030), or written to the counter outside the hold path, appears only as unattributed; nights a plan sold on its own row before joining a pool are not pool consumption; attribution needs read access to the hold tables.

### 3. The capacity editor
`POST .../pools/:poolId/capacity/preview` (writes nothing) and `.../apply`. One request edits one pool over a bounded range (at most 366 nights, optional weekday filter, capacity 0 to 9999).

- **Blank is unchanged, zero is a value.** A missing, null or empty capacity is refused ("nothing to apply"); `0` is an intentional capacity of zero. Negative, fractional, out-of-range or non-numeric values are rejected, never clamped.
- **Floor.** A night whose `sold + held` exceeds the new capacity is `INVALID`, with the numbers. Holds, sold units and consumption are never deleted or ignored to make an edit succeed. Nights before the hotel-local today are invalid.
- **Existing nights only (amended).** A night with no pool stock row is `INVALID` ("no pool stock row (unknown, not zero)"); the editor never creates one. See Amendment 1.
- **Preview fingerprint.** A SHA-256 over the request, the pool status, and for every selected night its absence or its capacity, sold, held and version. Apply recomputes it inside the transaction and refuses (`409 POOL_CAPACITY_STALE`) if anything changed: another capacity edit, consumption, a created or deleted night, or a different request.
- **Atomic and race-safe.** One transaction under the same per-hotel advisory locks Quick Update and pool administration use (taken in a fixed order). Each changed night is written with a guarded `UPDATE ... WHERE sold + held <= capacity`, so a hold that lands between the check and the write makes the apply fail (`POOL_CAPACITY_STALE`, nothing written) rather than breach the invariant. The hold path's own guarded `UPDATE` protects the other direction.
- **Idempotent.** An `idempotencyKey` (8-80 characters) is recorded on the audit event with a request hash. A replay returns the original result without writing; the same key with a different request is `409 IDEMPOTENCY_KEY_REUSED`.
- **Audit.** One immutable `inventory.pool.capacity_changed` event in the same transaction: actor, request id, reason (3-500 characters), pool, range, weekdays, capacity, counts, before and after fingerprints and a sample of nights. Denials are recorded by the existing permission guard.
- **Provenance.** A written night is stamped source `ADMIN`, fresh, no expiry (ADR 0030, decision 7).
- It does not allocate stock, create or release holds, change prices, modes or restrictions, or enable booking. The e2e suite proves plan availability rows and daily rates are byte-identical after an apply.

### 4. Permissions (three separate grants)
| Action | Permission |
| --- | --- |
| View pool detail and consumption | `supply.availability.read` (existing) |
| Preview a capacity edit | `supply.pool_capacity.preview` (new) |
| Apply a capacity edit | `supply.pool_capacity.apply` (new) |

The new keys are inserted into the `Permission` catalogue by the data-only migration and are granted to **no** role by it. Roles that today hold `supply.availability.manage` do not gain the editor until an administrator assigns the new permissions. Apply does not require the preview permission, but the fingerprint it needs comes from a preview, so roles should hold both. The Admin UI hides what a caller cannot use; the API is the authorizer. Tenant identity comes from the session; tenant, hotel and pool are verified server-side (another tenant's, another hotel's or an unknown pool is 404).

### 5. Routes
`GET .../pools/:poolId` (detail, window up to 90 nights), `GET .../pools/:poolId/consumption` (up to 62 nights; one aggregate query bounded by nights x plans x statuses), and the two POSTs above. The Admin UI extends the existing Inventory & Allotment tab: the pool card links to a pool workspace (`?tab=inventory&pool=<id>`).

### 6. Strict runtime role: no grant change, honest behaviour (superseded by Amendment 1)
Under ADR 0032 the API role has **no write privilege on `InventoryPool` or `InventoryPoolDay`** (privileged path) and **no read on the hold tables**. Widening either would give every ordinary Admin session privileged pool authoring and hold visibility, which this change does not do. On a deployment running the strict role:

- Viewing the pool and previewing work (both read tables the role already reads).
- Attribution is reported `unavailable` (`OPERATIONS_READ_DENIED`), with pool totals still exact: unknown, never zero.
- Applying answers the existing typed **403 `RUNTIME_ROLE_OPERATION_PROHIBITED`** (the contract forbids the write), nothing is written, and the body carries no SQL, table or column.
- If a grant the contract does give the role is missing (drift), an authorized caller gets the sanitized **503 `DATABASE_ROLE_NOT_PERMITTED`**, never a caller 403.

Making apply and attribution work on a strict deployment needs an owner decision, the same one ADR 0032 left open for pool authoring: a privileged administrative principal for these paths (or, for attribution only, a column-level read of `InventoryHold(rate_plan_id, status)` and `InventoryHoldNight(pool_day_id, counter_kind, quantity)`, which the contract mechanism does not yet express). Until then the editor is usable where the API connects with a role that holds those privileges (local, CI and operator-run environments).

### 7. Not decided here
Editing capacity across several pools in one request; scheduled or recurring capacity changes; capacity history charts (the audit trail holds the history); moving a plan between pools with sold units; supplier-pushed capacity feeds.

## Consequences
- Operators get a bounded, previewed, audited way to set pool capacity and to see who is using it, using the one counter set Agent search already reads.
- Quick Update is unchanged and can still write pool capacity; both paths use the same guarded write and the same locks, so they cannot interleave unsafely.
- Rollback: delete the two `Permission` rows (see the migration header) and revert the code. No data, schema, index, RLS or grant change to undo.


## Amendment 1: functional under the strict API database role
Status: accepted for the repository implementation and disposable local certification. It does not authorize a persistent grant change, a migration against a persistent database, deployment or any live transaction.

### Decision
Section 6 left Apply refused and attribution `unavailable` on the strict role (ADR 0032). That is replaced by a least-privilege grant, expressed in the single runtime-role contract (`apps/api/src/database/runtime-role-contract.ts`) and therefore in provisioning, the verifier, the generated matrix and the 403-versus-503 classification:

| Table | Privilege | Columns | Why |
| --- | --- | --- | --- |
| `InventoryPoolDay` | UPDATE (column level) | `capacity`, `source`, `source_updated_at`, `received_at`, `fresh_until`, `updated_at` | `PoolCapacityService.apply` (and the same guarded statement from Quick Update on pooled plans) sets capacity and stamps ADMIN provenance |
| `InventoryHold` | SELECT (column level) | `id`, `tenant_id`, `rate_plan_id`, `status` | per-plan consumption: which plan holds a unit, in which lifecycle state |
| `InventoryHoldNight` | SELECT (column level) | `tenant_id`, `hold_id`, `pool_day_id`, `counter_kind`, `quantity` | the recorded pool night and quantity |

Not granted: INSERT or DELETE on `InventoryPoolDay`; UPDATE of `sold`, `held`, `tenant_id`, `pool_id`, `stay_date`, `id`, `created_at`; any write on `InventoryHold`, `InventoryHoldNight`, `InventoryPool`, `RatePlan`, `DailyAvailability`, bookings or `SupplierMutation`; any hold column holding guest, contact, offer, search, idempotency, request, money or user data, and `SELECT *` on the hold tables. `tenant_id` is readable because row-level security policies are evaluated with the caller's privileges. RLS stays forced and is not weakened; no `SECURITY DEFINER` function is used.

### Consequences for the editor
- **No creation.** Creating a pool night needs INSERT, which the role never holds. A night without a stock row is refused at preview (`INVALID`) and at apply (`422 POOL_CAPACITY_INVALID`), nothing written. Pool authoring and stock rows remain a privileged path.
- **Attribution is `available` on a correctly provisioned role** and reconciles with the authoritative counters (unattributed = counter - attributed; negative means inconsistent). The attribution query names exactly the granted columns; no implicit ORM column list reads the hold tables.
- **Error semantics are unchanged.** Not authorized by the application: the existing typed 403 (permissions `supply.availability.read`, `supply.pool_capacity.preview`, `supply.pool_capacity.apply` are unchanged and granted to no role). A statement outside the contract (for example a Quick Update that would create a pool night): `403 RUNTIME_ROLE_OPERATION_PROHIBITED`. A privilege the contract grants but the database lacks (drift, including a missing column read): sanitized `503 DATABASE_ROLE_NOT_PERMITTED`, never an `unavailable` attribution and never a zero. Stale preview: `409 POOL_CAPACITY_STALE`; unsafe capacity: `422 POOL_CAPACITY_INVALID`.
- **Quick Update** gains nothing it could not already do: its guarded pooled-plan capacity statement uses the same column set; a Quick Update touching other tables (rates, availability rows) is still outside the contract.

### Verifier
The verifier (run as the login role) now reports: any SELECT outside the contract (table-level or an extra column), a table-level SELECT that would override a column restriction, a missing required column read, extra or missing write columns, owned objects, elevated attributes and any membership other than the group role.

### Migration and rollback
`202610260001_strict_runtime_role_pool_capacity` is forward-only and a no-op when the group role does not exist. It revokes everything on the three tables from the group role and re-grants exactly the rows above, which equals the contract output (a unit test replays the migrations in order and compares). It must not be applied to a persistent database without an owner decision. Rollback (documented in the migration header): `REVOKE UPDATE (...) ON "InventoryPoolDay"`, `REVOKE SELECT (...) ON "InventoryHold", "InventoryHoldNight"` and revert the code; no data change.

## Amendment 2: creating missing pool nights is an owner-run tool, not an API capability
Amendment 1 made the editor refuse a night with no stock row, because creating one needs INSERT and pool authoring is a privileged path (ADR 0032). Operators still need a way to open new nights. Decision: **no runtime grant**. `pnpm --filter @bedbanks/api ops:pool-nights` (`apps/api/src/inventory/pool-night-authoring.ts`) runs with the database owner credential, never inside the API process:

- Preview by default (writes nothing, prints the nights it would create, the existing nights it leaves alone, nights before the hotel-local today it skips, and a fingerprint). `--apply` writes; `--expect=<fingerprint>` makes apply refuse if the set of missing nights changed since the preview.
- It only INSERTs missing rows (`ON CONFLICT DO NOTHING`); an existing night, `sold` and `held` are never updated. Capacity 0 to 9999, at most 366 nights, a reason and the operator's name are required. The tenant is named explicitly and set as the transaction's tenant context, so forced RLS applies to the owner session as well. The pool must be ACTIVE.
- It takes the same per-hotel advisory locks as the editor and Quick Update, in the same order.
- One immutable `inventory.pool.nights_created` audit event (actor type SYSTEM, the operator named in the payload) per applied run that created something; a re-run creates nothing and records nothing.
- Remote targets need `--allow-remote --confirm-database=<name>`, like the other owner commands. Nothing was run against a persistent database.
A night created this way becomes bookable only where the plans also have availability rows and are otherwise sellable (ADR 0030, decision 4).
