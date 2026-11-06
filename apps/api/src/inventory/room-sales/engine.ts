/**
 * Room sales controls (ADR 0113). Pure: no database and no clock of its own.
 * Inventory counts, sales mode and commercial eligibility stay separate. Latest-write does not resolve overlapping rules.
 */
import { createHash } from 'crypto'
import {
  POST_RELEASE_POLICIES, ROOM_SALES_LIMITS, ROOM_SALES_MODES,
  type PostReleasePolicy, type RoomSalesMode, type RoomSalesOutcome, type RoomSalesRuleView,
} from '@bedbanks/contracts'

export type { RoomSalesRuleView }

const DAY = 86_400_000
export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
export type Weekday = (typeof WEEKDAYS)[number]
const SIMULATED_LABEL = 'Simulated channel adapter — no live supplier connection'

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10)
}

/** Check-in inclusive, check-out exclusive. */
export function stayNights(checkIn: string, checkOut: string): string[] | null {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) return null
  const nights: string[] = []
  for (let date = checkIn; date < checkOut; date = addDays(date, 1)) {
    nights.push(date)
    if (nights.length > 30) return null
  }
  return nights
}

/** Bulk editing: both ends inclusive. */
export function inclusiveDates(from: string, to: string): string[] | null {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return null
  const dates: string[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date)
    if (dates.length > ROOM_SALES_LIMITS.rangeDays) return null
  }
  return dates
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[(new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7]
}

/** Hotel-local calendar date. An unusable zone returns null so callers fail closed. */
export function hotelLocalDate(now: Date, timeZone: string): string | null {
  if (!timeZone) return null
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
    const get = (type: string) => parts.find((part) => part.type === type)?.value
    const year = get('year'), month = get('month'), day = get('day')
    if (!year || !month || !day) return null
    const date = `${year}-${month}-${day}`
    return isIsoDate(date) ? date : null
  } catch {
    return null
  }
}

export function scopeKey(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value.trim() : ''
}

/** Contractual free sale is the contract allotment type FREE_SALE. Anything else, including unset, stays finite. */
export function freeSaleConsumesInventory(allotmentType: string | null | undefined): boolean {
  return allotmentType !== 'FREE_SALE'
}

export interface InventoryTerms {
  contracted: number
  approvedAdjustment: number
  confirmed: number
  activeHolds: number
  blocked: number
  /** When the supplier allocation already excludes out-of-service rooms, do not subtract them again. */
  blockedAlreadyExcluded: boolean
}

export function availableInventory(terms: InventoryTerms): number {
  const blocked = terms.blockedAlreadyExcluded ? 0 : terms.blocked
  return terms.contracted + terms.approvedAdjustment - terms.confirmed - terms.activeHolds - blocked
}

export function remainingCap(cap: number, capConsumingBookings: number, capConsumingHolds: number): number {
  return cap - capConsumingBookings - capConsumingHolds
}

export interface ResolvedSales {
  configuredMode: RoomSalesMode | null
  stopSale: boolean
  onRequest: boolean
  /** Null when no Limited rule applies. Negative means the cap is already below commitments. */
  capRemaining: number | null
  /** A cap applies but the counter is missing, so the night cannot be sold. */
  capUnknown: boolean
  overCap: boolean
  consumesInventory: boolean
  applicable: number
}

export interface ResolveInput {
  rules: readonly RoomSalesRuleView[]
  roomTypeId: string
  ratePlanId: string
  poolId: string | null
  contractId: string | null
  stayDate: string
  channel: string | null
  market: string | null
  now: Date
  /** sold + held of the shared counter. Null when that counter row does not exist. */
  consumed: number | null
}

function applies(rule: RoomSalesRuleView, input: ResolveInput): boolean {
  if (rule.roomTypeId !== input.roomTypeId || rule.stayDate !== input.stayDate) return false
  if (rule.poolKey !== '' && rule.poolKey !== scopeKey(input.poolId)) return false
  if (rule.planKey !== '' && rule.planKey !== input.ratePlanId) return false
  if (rule.channelKey !== '' && rule.channelKey !== scopeKey(input.channel)) return false
  if (rule.marketKey !== '' && rule.marketKey !== scopeKey(input.market)) return false
  if (rule.contractKey !== '' && rule.contractKey !== scopeKey(input.contractId)) return false
  if (rule.overrideExpiresAt && Date.parse(rule.overrideExpiresAt) <= input.now.getTime()) return false
  return true
}

/**
 * Every matching rule applies. A stop at any breadth blocks. A narrower Free Sale cannot reopen it.
 * Overlapping caps keep the smallest remaining allowance. On Request at any matching breadth prevents instant confirmation.
 */
export function resolveRoomSales(input: ResolveInput): ResolvedSales {
  const matched = input.rules.filter((rule) => applies(rule, input))
  const stopSale = matched.some((rule) => rule.mode === 'STOP_SALE')
  const onRequest = matched.some((rule) => rule.mode === 'ON_REQUEST')
  const caps = matched.filter((rule) => rule.mode === 'LIMITED' && rule.salesCap !== null && rule.salesCap > 0)
  // `consumed` is confirmed bookings plus active holds, so the hold term is zero here and is not subtracted twice.
  const capRemaining = caps.length > 0 && input.consumed !== null ? Math.min(...caps.map((rule) => remainingCap(rule.salesCap!, input.consumed!, 0))) : null
  const capUnknown = caps.length > 0 && input.consumed === null
  const overCap = capRemaining !== null && capRemaining < 0
  const consumesInventory = matched.some((rule) => rule.consumesInventory)
  const configuredMode: RoomSalesMode | null = stopSale ? 'STOP_SALE'
    : onRequest ? 'ON_REQUEST'
    : caps.length > 0 ? 'LIMITED'
    : matched.some((rule) => rule.mode === 'FREE_SALE') ? 'FREE_SALE'
    : null
  return { configuredMode, stopSale, onRequest, capRemaining, capUnknown, overCap, consumesInventory, applicable: matched.length }
}

export interface EffectiveInput {
  resolved: ResolvedSales
  /** True when at least one verified positive rate exists for a plan in scope. */
  verifiedRate: boolean
  quarantinedRate: boolean
  /** Finite remaining inventory. Null means the counter is unknown, not zero. */
  inventoryRemaining: number | null
  /** Legacy inventory mode when no sales rule is saved. */
  legacyMode: 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED' | null
  legacyStop: boolean
  roomsRequested: number
}

export function effectiveOutcome(input: EffectiveInput): { outcome: RoomSalesOutcome; reasons: string[] } {
  const reasons: string[] = []
  if (input.resolved.applicable === 0 && !input.legacyStop && input.legacyMode === null) {
    return { outcome: 'NOT_CONFIGURED', reasons: ['No sales-control rule is saved for this scope. Missing configuration is not Free Sale.'] }
  }
  if (input.legacyStop || input.legacyMode === 'CLOSED' || input.resolved.stopSale) reasons.push('Stop Sale blocks new sales. Existing bookings stay.')
  if (input.quarantinedRate) reasons.push('A rate for this night is quarantined and cannot be sold.')
  else if (!input.verifiedRate) reasons.push('No verified rate for this scope.')
  if (input.resolved.overCap) reasons.push('The sales cap is below existing commitments. Further sales are blocked and bookings are kept.')
  if (input.resolved.capUnknown) reasons.push('A sales cap applies but inventory consumption is unknown.')
  const needsStock = input.resolved.configuredMode !== null && input.resolved.configuredMode !== 'STOP_SALE' && (input.resolved.consumesInventory || input.resolved.configuredMode === 'LIMITED')
  if (needsStock) {
    if (input.inventoryRemaining === null) reasons.push('Inventory for this night is unknown, not zero.')
    else if (input.inventoryRemaining < input.roomsRequested) reasons.push('Not enough remaining inventory.')
  }
  if (input.resolved.capRemaining !== null && Math.max(0, input.resolved.capRemaining) < input.roomsRequested) reasons.push('The remaining sales cap is not enough.')
  if (input.legacyMode === 'ON_REQUEST' || input.resolved.onRequest) reasons.push('Supplier confirmation is required before this stay can be confirmed.')
  if (input.resolved.applicable === 0 && reasons.length === 0) {
    return { outcome: 'NOT_CONFIGURED', reasons: ['No sales-control rule is saved. The rate-plan inventory mode still applies at booking time and is not shown as Free Sale.'] }
  }
  const hard = reasons.filter((reason) => !reason.startsWith('Supplier confirmation'))
  if (hard.length > 0) return { outcome: reasons.some((reason) => reason.startsWith('Stop Sale')) ? 'STOPPED' : 'UNAVAILABLE', reasons }
  if (reasons.some((reason) => reason.startsWith('Supplier confirmation'))) return { outcome: 'ON_REQUEST', reasons }
  if (input.resolved.configuredMode === null) return { outcome: 'NOT_CONFIGURED', reasons: ['No sales-control rule is saved for this scope.'] }
  return { outcome: 'INSTANT', reasons: ['Instant confirmation is allowed only while inventory, cap, rate and restrictions still pass at commitment.'] }
}

export function sellableQuantity(inventoryRemaining: number | null, capRemaining: number | null, unlimited: boolean): number | null {
  if (unlimited) return null
  const inventory = inventoryRemaining === null ? 0 : Math.max(0, inventoryRemaining)
  if (capRemaining === null) return inventory
  return Math.max(0, Math.min(inventory, capRemaining))
}

export interface BatchCell {
  roomTypeId: string
  stayDate: string
  expectedVersion: number | null
  current: { version: number; mode: RoomSalesMode; planKey: string; channelKey: string; marketKey: string; contractKey: string } | null
}

export interface BatchPlan {
  ok: boolean
  errors: string[]
  conflicts: string[]
  cells: BatchCell[]
  reopensBroad: boolean
  consumesInventory: boolean
}

export function planSalesBatch(input: {
  roomTypeIds: string[]
  from: string
  to: string
  weekdays: string[]
  mode: string
  salesCap: number | null
  deadlineHours: number | null
  owner: string | null
  escalation: string | null
  reason: string
  confirmBroadReopen: boolean
  canReopenBroad: boolean
  allotmentType: string | null
  current: BatchCell[]
  /** When set, only these room nights are changed. Otherwise every room and inclusive date is changed. */
  targets?: Array<{ roomTypeId: string; stayDate: string }>
}): BatchPlan {
  const errors: string[] = []
  const dates = inclusiveDates(input.from, input.to)
  if (!dates) errors.push('Stay date from and stay date to must be inclusive calendar dates, at most 62 nights, with from on or before to.')
  if (input.roomTypeIds.length === 0) errors.push('Select at least one room type, or All room types.')
  if (!(ROOM_SALES_MODES as readonly string[]).includes(input.mode)) errors.push('Choose Free Sale, Stop Sale, On Request or Limited.')
  const mode = input.mode as RoomSalesMode
  if (mode === 'LIMITED' && (!Number.isInteger(input.salesCap) || (input.salesCap ?? 0) < 1 || (input.salesCap ?? 0) > ROOM_SALES_LIMITS.capMax)) errors.push('Limited needs a sales cap from 1 to 9999 for each stay night.')
  if (mode === 'ON_REQUEST') {
    if (!Number.isInteger(input.deadlineHours) || (input.deadlineHours ?? 0) < 1 || (input.deadlineHours ?? 0) > ROOM_SALES_LIMITS.deadlineHoursMax) errors.push('On Request needs a response deadline between 1 and 168 hours.')
    if (!input.owner || input.owner.trim().length < 2) errors.push('On Request needs an owner.')
    if (!input.escalation || input.escalation.trim().length < 3) errors.push('On Request needs an escalation policy.')
  }
  const reason = input.reason.trim()
  if (reason.length < ROOM_SALES_LIMITS.reasonMin || reason.length > ROOM_SALES_LIMITS.reasonMax) errors.push('A reason is required.')
  const allowed = new Set(input.weekdays.length === 0 ? WEEKDAYS : input.weekdays)
  if ([...allowed].some((day) => !(WEEKDAYS as readonly string[]).includes(day))) errors.push('Weekdays must be MON to SUN.')
  const selected = (dates ?? []).filter((date) => allowed.has(weekdayOf(date)))
  const wanted = new Map<string, BatchCell>()
  const listed = input.targets ?? input.roomTypeIds.flatMap((roomTypeId) => selected.map((stayDate) => ({ roomTypeId, stayDate })))
  for (const target of listed) {
    if (!isIsoDate(target.stayDate)) { errors.push('A stay date is not a calendar date.'); continue }
    wanted.set(`${target.roomTypeId}|${target.stayDate}`, { roomTypeId: target.roomTypeId, stayDate: target.stayDate, expectedVersion: null, current: null })
  }
  if (wanted.size === 0) errors.push('No stay nights match the dates and weekdays.')
  if (wanted.size > ROOM_SALES_LIMITS.cells) errors.push('Too many cells in one save.')
  const conflicts: string[] = []
  let reopensBroad = false
  for (const cell of input.current) {
    const key = `${cell.roomTypeId}|${cell.stayDate}`
    const target = wanted.get(key)
    if (!target) continue
    target.current = cell.current
    target.expectedVersion = cell.expectedVersion
    if ((cell.current?.version ?? null) !== cell.expectedVersion) conflicts.push(`${cell.stayDate} was saved by someone else. Reload before saving.`)
    const broad = cell.current?.mode === 'STOP_SALE' && cell.current.planKey === '' && cell.current.channelKey === '' && cell.current.marketKey === '' && cell.current.contractKey === ''
    if (broad && mode !== 'STOP_SALE') reopensBroad = true
  }
  if (reopensBroad && !input.confirmBroadReopen) errors.push('Reopening a room-wide Stop Sale needs an explicit confirmation.')
  if (reopensBroad && !input.canReopenBroad) errors.push('Reopening a room-wide Stop Sale needs hotel management authority.')
  const consumesInventory = mode === 'LIMITED' || mode === 'STOP_SALE' || ((mode === 'FREE_SALE' || mode === 'ON_REQUEST') && freeSaleConsumesInventory(input.allotmentType))
  if ((mode === 'FREE_SALE' || mode === 'ON_REQUEST') && !consumesInventory && input.allotmentType !== 'FREE_SALE') errors.push('Selling beyond finite allocation is not authorized on this contract.')
  return { ok: errors.length === 0 && conflicts.length === 0, errors, conflicts, cells: [...wanted.values()], reopensBroad, consumesInventory }
}

export function salesFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export interface StockNight { id: string; available: number; version: number }
export interface ReserveRequest { idempotencyKey: string; fingerprint: string; nights: string[]; rooms: number }

export interface ReserveState {
  stock: Map<string, StockNight>
  seen: Map<string, { fingerprint: string; result: 'reserved' | 'rejected' }>
}

/** All nights or none. A repeated key with the same fingerprint does not consume again. */
export function reserveFinite(state: ReserveState, request: ReserveRequest): { state: ReserveState; result: 'replay' | 'conflict' | 'reserved' | 'rejected'; reason?: string } {
  const prior = state.seen.get(request.idempotencyKey)
  if (prior && prior.fingerprint === request.fingerprint) {
    return prior.result === 'reserved'
      ? { state, result: 'replay' }
      : { state, result: 'rejected', reason: 'This request was already rejected. Inventory was not consumed again.' }
  }
  if (prior) return { state, result: 'conflict', reason: 'This idempotency key was already used for a different request.' }
  if (!Number.isInteger(request.rooms) || request.rooms < 1) return { state, result: 'rejected', reason: 'Room quantity must be a positive integer.' }
  for (const night of request.nights) {
    const row = state.stock.get(night)
    if (!row || row.available < request.rooms) {
      const seen = new Map(state.seen)
      seen.set(request.idempotencyKey, { fingerprint: request.fingerprint, result: 'rejected' })
      return { state: { stock: state.stock, seen }, result: 'rejected', reason: `Not enough inventory on ${night}. Nothing was reserved.` }
    }
  }
  const stock = new Map(state.stock)
  for (const night of request.nights) {
    const row = stock.get(night)!
    stock.set(night, { ...row, available: row.available - request.rooms, version: row.version + 1 })
  }
  const seen = new Map(state.seen)
  seen.set(request.idempotencyKey, { fingerprint: request.fingerprint, result: 'reserved' })
  return { state: { stock, seen }, result: 'reserved' }
}

/**
 * Secure every replacement night before releasing the original. On failure the original stock is unchanged.
 * Overlapping nights count the booking's own units as still available to itself.
 */
export function amendFinite(state: ReserveState, original: { nights: string[]; rooms: number }, replacement: ReserveRequest): { state: ReserveState; result: 'reserved' | 'rejected'; reason?: string } {
  const availableToSelf = (night: string) => (state.stock.get(night)?.available ?? -1) + (original.nights.includes(night) ? original.rooms : 0)
  for (const night of replacement.nights) {
    if (availableToSelf(night) < replacement.rooms) return { state, result: 'rejected', reason: `Replacement inventory is not available on ${night}. The original booking is unchanged.` }
  }
  const stock = new Map(state.stock)
  for (const night of original.nights) {
    const row = stock.get(night)
    if (row) stock.set(night, { ...row, available: row.available + original.rooms })
  }
  for (const night of replacement.nights) {
    const row = stock.get(night)
    if (!row || row.available < replacement.rooms) return { state, result: 'rejected', reason: 'Replacement inventory changed. The original booking is unchanged.' }
    stock.set(night, { ...row, available: row.available - replacement.rooms, version: row.version + 1 })
  }
  return { state: { stock, seen: state.seen }, result: 'reserved' }
}

export function releaseOnCancel(policy: 'RELEASE' | 'RETAIN', quantity: number): number {
  return policy === 'RELEASE' ? quantity : 0
}

export function holdsToExpire(holds: ReadonlyArray<{ id: string; status: string; expiresAt: string }>, now: Date): string[] {
  return holds.filter((hold) => hold.status === 'ACTIVE' && Date.parse(hold.expiresAt) <= now.getTime()).map((hold) => hold.id)
}

export interface DistributionJobState { state: 'PENDING' | 'ACKNOWLEDGED' | 'FAILED'; attempts: number; lastError: string | null }

/** Internal save and channel acknowledgement are different. A second delivery of an acknowledged job does not send again. */
export function applyDelivery(job: DistributionJobState, result: { acknowledged: boolean; error?: string }): DistributionJobState {
  if (job.state === 'ACKNOWLEDGED') return job
  if (result.acknowledged) return { state: 'ACKNOWLEDGED', attempts: job.attempts + 1, lastError: null }
  return { state: 'FAILED', attempts: job.attempts + 1, lastError: result.error ?? 'Delivery failed' }
}

export const simulatedDistribution = { simulated: true as const, label: SIMULATED_LABEL }

export function postReleaseMode(policy: PostReleasePolicy): RoomSalesMode {
  if (!(POST_RELEASE_POLICIES as readonly string[]).includes(policy)) throw new Error('POST_RELEASE_POLICY')
  if (policy === 'ON_REQUEST') return 'ON_REQUEST'
  if (policy === 'AUTHORIZED_FREE_SALE') return 'FREE_SALE'
  return 'STOP_SALE'
}

/** Release unused units only. Confirmed and held units stay. */
export function releasedContracted(terms: InventoryTerms): { contracted: number; overCommitment: boolean } {
  const kept = terms.confirmed + terms.activeHolds
  const blocked = terms.blockedAlreadyExcluded ? 0 : terms.blocked
  const contracted = kept - terms.approvedAdjustment + blocked
  return { contracted: Math.max(0, contracted), overCommitment: availableInventory(terms) < 0 }
}

export function idempotencyDecision(storedHash: string | null, requestHash: string): 'new' | 'replay' | 'conflict' {
  if (storedHash === null) return 'new'
  return storedHash === requestHash ? 'replay' : 'conflict'
}
