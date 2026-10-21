/**
 * Rules a feed's stock statements must satisfy before anything may be promoted into availability or pool capacity (ADR 0083, owner decisions 3a, 3b, 3c and 4).
 * Pure: no I/O, no clock, integer maths and ISO dates only. Promotion itself is not built; these are the gates it must call, written and tested first.
 */
export type StockSemantics = 'REMAINING' | 'TOTAL'
export type StockBlock = 'COUNT_SEMANTICS_UNDECLARED' | 'COUNT_BELOW_COMMITTED' | 'COUNT_INVALID'

export interface StockCount { semantics: StockSemantics | null | undefined; /** The feed's number. */ count: number; /** Units already sold and held against the counter being written (plan night or pool night). */ sold: number; held: number }
export type StockPlan = { ok: true; /** The ALLOTMENT value (or pool capacity) to write. */ allotment: number } | { ok: false; block: StockBlock }

const MAX_STOCK = 9_999

/**
 * REMAINING: units still sellable on the supplier's side, so the counter becomes sold + held + count and we can never sell more than the supplier has.
 * TOTAL: the counter becomes the count, and a count below what is already sold and held is refused (never clamped, never deleted around).
 * The semantics must be declared by the source's profile; it is never assumed.
 */
export function planStockCount(i: StockCount): StockPlan {
  if (i.semantics !== 'REMAINING' && i.semantics !== 'TOTAL') return { ok: false, block: 'COUNT_SEMANTICS_UNDECLARED' }
  if (![i.count, i.sold, i.held].every((n) => Number.isInteger(n) && n >= 0)) return { ok: false, block: 'COUNT_INVALID' }
  const committed = i.sold + i.held
  if (i.semantics === 'REMAINING') {
    const allotment = committed + i.count
    return allotment > MAX_STOCK ? { ok: false, block: 'COUNT_INVALID' } : { ok: true, allotment }
  }
  if (i.count > MAX_STOCK) return { ok: false, block: 'COUNT_INVALID' }
  return i.count < committed ? { ok: false, block: 'COUNT_BELOW_COMMITTED' } : { ok: true, allotment: i.count }
}

export type RoomStockBlock = 'NEEDS_POOL'
export interface RoomPlanFacts { ratePlanId: string; poolId: string | null; poolActive: boolean }
export type RoomStockRoute = { ok: true; poolId: string } | { ok: false; block: RoomStockBlock; /** Plans that are not in the common pool, for the review list. */ offending: string[] }

/**
 * A room-wide statement is shared physical stock, so it sets the capacity of the one inventory pool all the room's feed-managed plans belong to. It is never copied to each plan.
 * No plans, any plan outside a pool, plans spread over different pools, or a pool that is not ACTIVE: blocked and listed for a person.
 */
export function routeRoomWideStock(plans: readonly RoomPlanFacts[]): RoomStockRoute {
  if (plans.length === 0) return { ok: false, block: 'NEEDS_POOL', offending: [] }
  const first = plans[0].poolId
  if (first === null) return { ok: false, block: 'NEEDS_POOL', offending: plans.filter((p) => p.poolId === null).map((p) => p.ratePlanId).sort() }
  const offending = plans.filter((p) => p.poolId !== first || !p.poolActive).map((p) => p.ratePlanId).sort()
  return offending.length === 0 ? { ok: true, poolId: first } : { ok: false, block: 'NEEDS_POOL', offending }
}

export type NightMode = 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED'
export interface NightState { source: string; stopSell: boolean; mode: NightMode }
export type NightWrite = { allowed: true } | { allowed: false; reason: 'MANUAL_CLOSE_STICKY' }

const isClosed = (n: { stopSell: boolean; mode: NightMode }) => n.stopSell || n.mode === 'CLOSED'

/**
 * A person's close is sticky: the feed may close more nights but never reopens a night whose current row was last written by a person (source ADMIN) and is stop-sold or CLOSED, until a person
 * reopens it. The night is skipped, not the batch. Uses the provenance the row already carries; no schema change.
 */
export function mayFeedWriteNight(current: NightState | null, incoming: { stopSell: boolean; mode: NightMode }): NightWrite {
  if (current && current.source === 'ADMIN' && isClosed(current) && !isClosed(incoming)) return { allowed: false, reason: 'MANUAL_CLOSE_STICKY' }
  return { allowed: true }
}

const DAY_MS = 86_400_000
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)

/**
 * Previously promoted nights a complete feed no longer mentions. Inside `[today, today + coverageDays]` they are closed; beyond the window, in the past, or when the profile declares no coverage
 * they are left alone (a night is never closed on a guess; its freshness expiry still stops it selling). Nights already closed are not returned. Call only for a batch that passed the
 * batch guard, and only for a COMPLETE feed: a held, partial or failed batch closes nothing.
 */
export function omittedNightsToClose(input: { promoted: ReadonlyMap<string, NightState>; incomingNights: ReadonlySet<string>; today: string; coverageDays: number | null | undefined }): string[] {
  const { coverageDays } = input
  if (coverageDays === null || coverageDays === undefined || !Number.isInteger(coverageDays) || coverageDays < 1 || coverageDays > 730) return []
  const from = dayNumber(input.today)
  const to = from + coverageDays
  return [...input.promoted.entries()]
    .filter(([night, state]) => { const d = dayNumber(night); return d >= from && d <= to && !input.incomingNights.has(night) && !isClosed(state) })
    .map(([night]) => night).sort()
}
