# ADR 0113: Room sales controls and allocation breakdown

Status: Accepted.

## Context
ADR 0030 already decides whether a rate-plan night counts stock, sells without counting, waits for a supplier, or is closed. Hotel and DMC operators also need a paint calendar for Free Sale, Stop Sale, On Request and Limited, plus a separate view of contracted allocation. Those are sales controls and an allocation breakdown. They are not a second stock counter.

## Decisions
1. **Three layers stay separate.** `InventoryPoolDay` remains the shared stock counter. `RoomSalesRule` records the configured sales mode for a room night and scope. Commercial eligibility stays in `evaluateContractedStay`. A Free Sale cell is not a booking confirmation.
2. **Painting Free Sale does not create unlimited stock.** `consumesInventory` is false only when the supplier contract allotment type is `FREE_SALE`. Every other contract keeps finite stock. A saved rule can stop a night, require a request, cap it, or force a legacy free-sale plan to consume stock. A hotel with no `RoomSalesRule` keeps its ADR 0030 behaviour, and the calendar shows that night as not configured.
3. **Precedence.** Every matching rule applies. Any Stop Sale blocks, including over a narrower Free Sale. Any On Request prevents instant confirmation. Overlapping caps keep the smallest remaining allowance. The latest write is not the resolution rule.
4. **Allocation.** `PoolNightAllocation` stores contracted quantity, approved adjustment, blocked quantity and the release policy. The physical capacity written to `InventoryPoolDay` is the intended figure, but never below confirmed bookings plus active holds. Reducing it below commitments keeps those bookings and leaves no units for a new sale.
5. **Saves are atomic.** A paint save writes the batch, the rules, the append-only audit rows and a pending distribution job in one transaction. A validation error or a stale version writes nothing and leaves the browser draft in place. Reopening a room-wide Stop Sale requires `supply.hotels.manage` and an explicit confirmation. Permissions stay `supply.availability.read` and `supply.availability.manage`.
6. **Distribution is simulated.** The built-in adapter is labelled as having no live supplier connection. Pending, acknowledged and failed are separate from the internal save. An acknowledged job is not sent again.
7. **On Request does not take an inventory hold.** A supplier request is a pending record with a deadline, owner and escalation policy. Approval rechecks eligibility and still does not create a reservation. The booking hold path rechecks Stop Sale, On Request, Limited caps and forced consumption for the portal channel and all-market rules.

## Consequences
- Migration `202612200001_room_sales_controls` is forward-only. Rollback is the drop order in its header. Row-level security is forced. Grants are in the runtime-role contract, not in the migration.
- Booking search loads rules and applies them in the existing evaluator. The hold path applies room, pool, plan and contract rules for the portal channel. A market-specific stop is enforced on search and on the eligibility endpoint when a market is supplied; the hold recheck sees all-market rules only.

## Not decided here
A live channel adapter, split bookings, and temporary holds for supplier requests.
