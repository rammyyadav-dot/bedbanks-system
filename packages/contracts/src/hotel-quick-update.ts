/**
 * Quick Update contracts (ADR 0021, stage 5): a previewed, atomic change to rates, availability and per-night restrictions for one
 * hotel, over a bounded set of rate plans and dates.
 *
 * - Every field opts in. An omitted field is unchanged; a blank price is "no change", never zero.
 * - Preview and apply share one validation. Apply re-reads the current data, so a preview is evidence, never authority.
 * - A batch is atomic: if any record is invalid, nothing is written.
 * - Money is a major-unit decimal string in the plan's currency, converted to integer minor units by the canonical money package.
 */

import type { InventoryMode } from './hotel-inventory';

export const QUICK_UPDATE_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type QuickUpdateWeekday = (typeof QUICK_UPDATE_WEEKDAYS)[number];
/** ADR 0067 F-13: a price change larger than this share of the stored rate needs an explicit confirmation to apply. */
export const PRICE_GUARDRAIL = { maxChangeBp: 5000 } as const;
export const QUICK_UPDATE_LIMITS = { plans: 5, ranges: 4, seasons: 12, rangeDays: 366, records: 500, reportedRows: 500 } as const;

export interface QuickUpdateScope {
  ratePlanIds: string[]
  ranges: Array<{ from: string; to: string }>
  /** Empty or omitted means every day of the week. */
  weekdays?: QuickUpdateWeekday[]
}

export type QuickUpdateFlag = 'SET' | 'CLEAR';
export interface QuickUpdateChanges {
  /** `occupancy` (ADR 0067, F-05) prices that occupancy of each plan (e.g. single use); omitted is each plan's own occupancy. */
  /**
   * Exactly one of: `amount` (SET, with `basis`); `seasons` (ADR 0067, F-14: a price per non-overlapping date window, with `basis`; every date in
   * scope must fall in one); `adjustPercentBp` (signed basis points on each stored rate, half away from zero); `adjustAmount` (signed major units
   * added to each stored rate). An adjustment needs a stored rate and keeps its basis.
   */
  price?: { amount?: string; basis?: 'NET' | 'SELL'; occupancy?: number; seasons?: Array<{ from: string; to: string; amount: string }>; adjustPercentBp?: number; adjustAmount?: string }
  /** `allotment` is the plan's own count, or the shared pool's capacity when the plan belongs to a pool (written once per pool night). */
  availability?: { allotment?: number; stopSell?: QuickUpdateFlag; mode?: InventoryMode }
  /** `closedToDeparture` applies to the DEPARTURE date: a stay may not end on a night where it is set. */
  /** `releaseDays` (ADR 0067, F-08) is the release for a check-in on the night, overriding the plan's; null clears the override. */
  restrictions?: { minStay?: number; closedToArrival?: QuickUpdateFlag; closedToDeparture?: QuickUpdateFlag; releaseDays?: number | null }
}
export interface QuickUpdateRequest { scope: QuickUpdateScope; changes: QuickUpdateChanges }

export type QuickUpdateField = 'price' | 'allotment' | 'poolCapacity' | 'stopSell' | 'inventoryMode' | 'minStay' | 'closedToArrival' | 'closedToDeparture' | 'releaseDays';
export interface QuickUpdateFieldChange {
  field: QuickUpdateField
  /** price: integer minor units as a string. allotment, poolCapacity and minStay: whole numbers. inventoryMode: a mode name. flags: booleans. null: no stored value. */
  from: string | number | boolean | null
  /** releaseDays: null clears the night's override, so the plan's release applies. */
  to: string | number | boolean | null
  currency?: string
}
export type QuickUpdateOutcome = 'CHANGE' | 'NO_CHANGE' | 'INVALID';
/** `warnings` (ADR 0067, F-13): large price changes; they do not make the row invalid but apply needs `confirmLargeChanges`. */
export interface QuickUpdateRow { ratePlanId: string; date: string; outcome: QuickUpdateOutcome; problems: string[]; changes: QuickUpdateFieldChange[]; warnings?: string[] }

export interface QuickUpdatePlanRef { id: string; code: string; roomName: string; boardCode: string; contractCode: string; supplierName: string; currency: string; occupancy: number; status: string }

export interface QuickUpdatePreview {
  generatedAt: string
  /** Opaque digest of the current values of every affected record. Send it back to apply; a different value means the data changed. */
  fingerprint: string
  hotelToday: string
  timeZone: string
  plans: QuickUpdatePlanRef[]
  dates: string[]
  counts: { records: number; willChange: number; unchanged: number; invalid: number; largePriceChanges?: number }
  rows: QuickUpdateRow[]
  truncated: boolean
  /** Request-level problems. When any exist there are no rows and nothing can be applied. */
  errors: string[]
  /** What this module deliberately does not do. */
  unsupported: string[]
  canApply: boolean
}

export interface QuickUpdateApply extends QuickUpdateRequest {
  idempotencyKey: string
  expectedFingerprint: string
  reason: string
  /** Required when the preview flagged large price changes (ADR 0067, F-13). */
  confirmLargeChanges?: boolean
}
export interface QuickUpdateApplied {
  replayed: boolean
  auditRequestId: string
  records: number
  changed: { rates: number; availabilityRows: number; poolDays: number }
  /** Digest of the same records after the write; a new preview of the same scope returns it. */
  fingerprintAfter: string
}

export const QUICK_UPDATE_UNSUPPORTED = [
  'Lock dates and Apply & Lock: lock scope, permissions, expiry and override behaviour are not defined, so locking is not offered.',
  'Maximum stay and cancellation terms are plan or contract level; edit them on the rate plan or the contract. The release deadline is edited in Inventory & Allotment.',
  'Partial application: a batch with any invalid record writes nothing.',
] as const;
