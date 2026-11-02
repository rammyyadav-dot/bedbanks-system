# ADR 0108: Hotel Contracting, Deals, Promotions, and Commercial Governance Alignment

Status: Accepted.
Date: 2026-11-02

## Context

A comprehensive audit of the hotel contracting, rate plans, deals/promotions (`HotelDeal`, `RatePlanPromotion`), supplements (`ContractSupplement`, `EventSupplement`), pricing engine (`evaluateContractedStay`), and booking/cancellation lifecycle surfaced four baseline defects and governance gaps introduced across recent merges:

1. **Unclassified Connector Runtime Role Models (`runtime-role-contract.spec.ts` failure):** `ConnectorDefinition`, `ConnectorCredentialReference`, `ConnectorExecution`, and `InventoryUpdateEvent` had write operations in `SupplyService` (`createConnector`, `ingestConnectorInventory`, `executeSupplierCancellation`), but were missing from `PRIVILEGED_WRITE_MODELS` in `apps/api/src/database/runtime-role-contract.ts`, breaking the strict runtime role necessity/drift invariant (ADR 0032).
2. **Direct `Booking.status` Mutation Bypass (`booking-status-writers.spec.ts` SW-01 failure):** `SupplyService.executeSupplierCancellation` updated `Booking.status` directly via `tx.booking.update({ data: { status: 'CANCELLED' } })`, bypassing `transitionBooking` (the single writer of `Booking.status` mandated by ADR 0039) and skipping immutable `BookingEvent` creation.
3. **Controller Read/Manage Guard Classification (`supply.controllers.spec.ts` failure):** `SupplyController.simulateCancellationPolicy` is a read-only `POST` endpoint gated by `supply.contracts.read`, but was not listed in the read-only `POST` allow-list in `supply.controllers.spec.ts`.
4. **Rate Plan & Room Occupancy Write-Time Consistency (Commercial Gap 1):** `SupplyService.createRatePlan` checked `occupancy >= 1` without validating `occupancy <= room.maxOccupancy` (unlike `updateRatePlan`), allowing DRAFT rate plans with impossible occupancy to be created. Conversely, `HotelRoomsService.update` allowed lowering `RoomType.maxOccupancy` below the `occupancy` of existing `ACTIVE` rate plans, silently rendering live rate plans unsellable (`OCCUPANCY_EXCEEDS_ROOM`).

## Decisions

1. **Strict Runtime Role Classification for Connector Models:** Register `ConnectorDefinition`, `ConnectorCredentialReference`, `ConnectorExecution`, and `InventoryUpdateEvent` in `PRIVILEGED_WRITE_MODELS` in `apps/api/src/database/runtime-role-contract.ts` and regenerate the privilege matrix in `docs/strict-runtime-db-role.md`. `ConnectorCredentialReference` remains strictly excluded from `RUNTIME_ROLE_GRANTS` (neither read nor written by `fbeds_api`).
2. **Single-Writer Booking Status Enforcement in Supplier Cancellation:** Route `SupplyService.executeSupplierCancellation` through `transitionBooking` (`systemRequestCancellation` followed by `systemCompleteCancellation` with idempotency keys bound to the cancellation request) so every status transition is compare-and-set guarded and writes an immutable `BookingEvent`.
3. **Read-Only POST Controller Guard Verification:** Include `simulateCancellationPolicy` in the read-only POST allow-list in `apps/api/src/supply/supply.controllers.spec.ts`.
4. **Shared Occupancy Consistency Guard (`planOccupancyValid`):**
   - Add `planOccupancyValid(occupancy, room)` in `apps/api/src/supply/room-rules.ts` and enforce `1 <= occupancy <= room.maxOccupancy` in `SupplyService.createRatePlan`.
   - In `HotelRoomsService.update`, when `maxOccupancy` is lowered, query `ACTIVE` rate plans on the room with `occupancy > nextMaxOccupancy` and refuse the update with `409 Conflict` (`ROOM_OCCUPANCY_BELOW_ACTIVE_PLANS`) naming the affected plans until they are suspended or updated.
5. **Documentation Alignment:** Update `docs/rate-certification.md` to reflect implemented promotions (ADR 0058), hotel deals and event supplements (ADR 0089), per-occupancy daily rates (ADR 0067 F-05), and source-market validity profiling (ADR 0107).
6. **Nest CLI Entry File Fix:** Fix `apps/api/nest-cli.json` `entryFile` from `"apps/api/src/main"` to `"main"` so `nest build` resolves `/workspace/apps/api/src/main.ts` rather than doubling `sourceRoot`.

## Consequences

- All 14 static architecture gates (`pnpm check:architecture`), schema checks, and unit test suites pass with zero failures.
- No database migration is required; existing schema constraints, triggers (`fbeds_hotel_deal_guard`, `fbeds_hotel_deal_plan_guard`), and forced RLS policies remain intact.
