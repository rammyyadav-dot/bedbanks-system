/**
 * Inventory & Allotment contracts (ADR 0030). One model for Admin Hotel Operations, the inventory calendar, Agent Search and recheck.
 *
 * - A night's stock lives on the rate plan row, or on the shared pool day when the plan belongs to a pool. A pool of 5 rooms
 *   shared by 3 plans is 5 units, never 15.
 * - Mode says how a night sells: ALLOTMENT counts stock, FREE_SALE needs none, ON_REQUEST is never instant, CLOSED never sells.
 * - A missing row or pool day means unknown, never zero. A stale row fails closed.
 * - Every mutation previews first, then applies atomically against the current data; money is not involved.
 */

export const INVENTORY_MODES = ['ALLOTMENT', 'FREE_SALE', 'ON_REQUEST', 'CLOSED'] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];
export type InventorySource = 'CONTRACT' | 'ADMIN' | 'SUPPLIER_API' | 'SUPPLIER_FEED' | 'SYSTEM';

/** Stable blocker codes the single evaluator may return for inventory. */
export const INVENTORY_BLOCKER_CODES = [
  'AVAILABILITY_MISSING', 'NO_INVENTORY', 'POOL_EXHAUSTED', 'STOP_SELL', 'INVENTORY_CLOSED', 'ON_REQUEST_ONLY', 'INVENTORY_STALE',
  'CLOSED_TO_ARRIVAL', 'CLOSED_TO_DEPARTURE', 'MIN_STAY_NOT_MET', 'MAX_STAY_EXCEEDED', 'RELEASE_DAYS_NOT_MET',
] as const;
export type InventoryBlockerCode = (typeof INVENTORY_BLOCKER_CODES)[number];

export const INVENTORY_LIMITS = { poolMembers: 20, poolNameMax: 80, releaseDaysMax: 365 } as const;

export interface InventoryPoolMember { ratePlanId: string; ratePlanCode: string; roomName: string; boardCode: string; contractCode: string; planStatus: string }
export interface InventoryPoolNight { date: string; capacity: number | null; sold: number | null; held: number | null; remaining: number | null; stale: boolean }
export interface InventoryPool {
  id: string; name: string; status: 'ACTIVE' | 'ARCHIVED'; supplierId: string; supplierName: string
  /** Optimistic concurrency token: send it back with every change. */
  updatedAt: string
  members: InventoryPoolMember[]
  /** One entry per night of the window; capacity null means the pool day does not exist (unknown, not zero). */
  nights: InventoryPoolNight[]
  missingNights: number
}

export interface InventoryPlanSummary {
  ratePlanId: string; ratePlanCode: string; roomName: string; boardCode: string; contractCode: string; supplierId: string; supplierName: string; planStatus: string
  poolId: string | null; poolName: string | null
  releaseDays: number
  /** Hotel-local HH:mm cut-off on the release day. */
  releaseTimeLocal: string
  /** Optimistic concurrency token for the release rule. */
  updatedAt: string
  modeCounts: Record<InventoryMode, number>
  nightsWithRow: number; nightsMissing: number; nightsStale: number
}

export interface HotelInventorySummary {
  hotelId: string; timeZone: string; generatedAt: string
  window: { from: string; to: string; days: number }
  plans: InventoryPlanSummary[]
  pools: InventoryPool[]
  totals: { plans: number; pooledPlans: number; pools: number; nightsMissing: number; nightsStale: number }
}

export interface InventoryPoolCreateRequest { name: string; supplierId: string; ratePlanIds?: string[]; idempotencyKey: string }
export interface InventoryPoolMembersRequest { ratePlanIds: string[]; expectedUpdatedAt: string; idempotencyKey: string }
export interface InventoryPoolUpdateRequest { name?: string; archive?: boolean; expectedUpdatedAt: string; idempotencyKey: string }
export interface InventoryReleaseRequest { releaseDays: number; releaseTimeLocal: string; expectedUpdatedAt: string; reason: string; idempotencyKey: string }
export interface InventoryPoolResult { replayed: boolean; pool: InventoryPool | null }
export interface InventoryReleaseResult { replayed: boolean; ratePlanId: string; releaseDays: number; releaseTimeLocal: string; updatedAt: string }
