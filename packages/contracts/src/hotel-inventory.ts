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

// ---- Pool detail, capacity editor and per-plan consumption (ADR 0036) ----------------------------------------------------------
import type { QuickUpdateWeekday } from './hotel-quick-update';

/**
 * Counter definitions. A pool night has one authoritative set of counters: capacity, sold and held, with `sold + held <= capacity` enforced by the database.
 * available = capacity - sold - held, computed once (the evaluator uses the same expression). Nothing else is subtracted and nothing is added.
 */
export const POOL_CAPACITY_LIMITS = { maxCapacity: 9999, maxRangeDays: 366, reportedRows: 400, reportMaxDays: 62, reasonMin: 3, reasonMax: 500 } as const;

/** Hold statuses and the pool counter they currently occupy. Every other status holds nothing (the units were returned or never taken). */
export const POOL_HOLD_STATUS_COUNTER: Readonly<Record<string, 'held' | 'sold' | 'none'>> = {
  HOLD_PENDING: 'held', HELD: 'held', PROCESSING: 'held', CONFIRMED: 'sold',
  RELEASED: 'none', EXPIRED: 'none', FAILED: 'none', PENDING_RECHECK: 'none', RECHECKED: 'none',
};

export interface PoolDayDetail {
  date: string
  /** False when the pool has no row for the night: unknown, never zero. The editor never creates one (adding nights is supply authoring). */
  exists: boolean
  capacity: number | null; sold: number | null; held: number | null; available: number | null
  stale: boolean; source: string | null; freshUntil: string | null; updatedAt: string | null
}

export interface InventoryPoolDetail {
  hotelId: string; hotelName: string; timeZone: string; hotelToday: string; generatedAt: string
  window: { from: string; to: string; days: number }
  pool: Omit<InventoryPool, 'nights'>
  rooms: Array<{ roomTypeId: string; name: string }>
  days: PoolDayDetail[]
  /** Pool events are recorded on the hotel audit trail with this pool id; the hotel Audit tab lists them (needs audit.read). */
  auditNote: string
}

export type PoolAttribution =
  | { state: 'available' }
  | { state: 'unavailable'; reason: string };

export interface PoolConsumptionPlan {
  ratePlanId: string; ratePlanCode: string; roomName: string; boardCode: string; contractCode: string
  /** False for a plan that recorded consumption on this pool and has since left it (historical attribution is kept). */
  member: boolean
  /** Window totals, null when attribution is unavailable. */
  held: number | null; sold: number | null
}

export interface PoolConsumptionNight {
  date: string
  exists: boolean
  capacity: number | null; sold: number | null; held: number | null; available: number | null
  /** Units attributed to each plan from the recorded counter references of its holds. Empty when attribution is unavailable. */
  plans: Array<{ ratePlanId: string; held: number; sold: number }>
  /** The part of the counter no hold explains (counter minus attributed). Negative means the holds claim more than the counter: inconsistent. Null when unknown. */
  unattributedHeld: number | null; unattributedSold: number | null
  /** True iff nothing is negative. Null when unknown. */
  consistent: boolean | null
}

export interface PoolConsumptionReport {
  hotelId: string; poolId: string; poolName: string; timeZone: string; generatedAt: string
  window: { from: string; to: string; days: number }
  plans: PoolConsumptionPlan[]
  nights: PoolConsumptionNight[]
  attribution: PoolAttribution
  totals: { nightsWithPoolDay: number; inconsistentNights: number; attributedHeld: number | null; attributedSold: number | null; unattributedHeld: number | null; unattributedSold: number | null }
  definitions: { counters: string; held: string; sold: string; excluded: string; attribution: string; limitations: string[] }
}

export interface PoolCapacityEditRequest {
  startDate: string; endDate: string
  /** MON to SUN. Empty or absent means every day of the range. */
  weekdays?: QuickUpdateWeekday[]
  /** A whole number from 0 to 9999. Blank (null or absent) means unchanged, and an edit with no capacity is refused. Zero is an intentional capacity of zero. */
  capacity: number | null
}

export type PoolCapacityOutcome = 'CHANGE' | 'UNCHANGED' | 'INVALID';

export interface PoolCapacityPreviewRow {
  date: string; weekday: QuickUpdateWeekday
  before: { capacity: number; sold: number; held: number; available: number } | null
  after: { capacity: number; available: number } | null
  outcome: PoolCapacityOutcome
  problems: string[]
}

export interface PoolCapacityPreview {
  generatedAt: string; poolId: string; poolName: string; timeZone: string; hotelToday: string
  /** Send back with the apply. Any change to the affected nights, to their consumption, or to the request makes it stale. */
  fingerprint: string
  counts: { dates: number; willChange: number; unchanged: number; invalid: number }
  rows: PoolCapacityPreviewRow[]; truncated: boolean
  errors: string[]
  canApply: boolean
  notes: string[]
}

export interface PoolCapacityApply extends PoolCapacityEditRequest { expectedFingerprint: string; reason: string; idempotencyKey: string }
export interface PoolCapacityApplied { replayed: boolean; auditRequestId: string; changed: { updated: number }; fingerprintAfter: string }
