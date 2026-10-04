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
export const QUICK_UPDATE_LIMITS = { plans: 5, ranges: 4, rangeDays: 366, records: 500, reportedRows: 500 } as const;

export interface QuickUpdateScope {
  ratePlanIds: string[]
  ranges: Array<{ from: string; to: string }>
  /** Empty or omitted means every day of the week. */
  weekdays?: QuickUpdateWeekday[]
}

export type QuickUpdateFlag = 'SET' | 'CLEAR';
export interface QuickUpdateChanges {
  price?: { amount: string; basis: 'NET' | 'SELL' }
  /** `allotment` is the plan's own count, or the shared pool's capacity when the plan belongs to a pool (written once per pool night). */
  availability?: { allotment?: number; stopSell?: QuickUpdateFlag; mode?: InventoryMode }
  /** `closedToDeparture` applies to the DEPARTURE date: a stay may not end on a night where it is set. */
  restrictions?: { minStay?: number; closedToArrival?: QuickUpdateFlag; closedToDeparture?: QuickUpdateFlag }
}
export interface QuickUpdateRequest { scope: QuickUpdateScope; changes: QuickUpdateChanges }

export type QuickUpdateField = 'price' | 'allotment' | 'poolCapacity' | 'stopSell' | 'inventoryMode' | 'minStay' | 'closedToArrival' | 'closedToDeparture';
export interface QuickUpdateFieldChange {
  field: QuickUpdateField
  /** price: integer minor units as a string. allotment, poolCapacity and minStay: whole numbers. inventoryMode: a mode name. flags: booleans. null: no stored value. */
  from: string | number | boolean | null
  to: string | number | boolean
  currency?: string
}
export type QuickUpdateOutcome = 'CHANGE' | 'NO_CHANGE' | 'INVALID';
export interface QuickUpdateRow { ratePlanId: string; date: string; outcome: QuickUpdateOutcome; problems: string[]; changes: QuickUpdateFieldChange[] }

export interface QuickUpdatePlanRef { id: string; code: string; roomName: string; boardCode: string; contractCode: string; supplierName: string; currency: string; occupancy: number; status: string }

export interface QuickUpdatePreview {
  generatedAt: string
  /** Opaque digest of the current values of every affected record. Send it back to apply; a different value means the data changed. */
  fingerprint: string
  hotelToday: string
  timeZone: string
  plans: QuickUpdatePlanRef[]
  dates: string[]
  counts: { records: number; willChange: number; unchanged: number; invalid: number }
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
