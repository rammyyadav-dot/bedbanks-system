import { majorUnitsToMinor } from '@bedbanks/money'
import {
  INVENTORY_MODES, QUICK_UPDATE_LIMITS, QUICK_UPDATE_WEEKDAYS,
  type QuickUpdateChanges, type QuickUpdateFieldChange, type QuickUpdateRequest, type QuickUpdateRow, type QuickUpdateWeekday,
} from '@bedbanks/contracts'

/**
 * Pure rules for Quick Update (ADR 0021, stage 5). No I/O: the service loads the current rows and applies the planned result.
 * Preview and apply both call `planQuickUpdate`, so they cannot disagree about validity.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MS = 86_400_000
const MAX_ALLOTMENT = 9999
const MAX_MIN_STAY = 365
/** Largest accepted rate in minor units. Well inside a safe integer and far above any real nightly rate. */
const MAX_AMOUNT_MINOR = 100_000_000_000n

export interface NormalisedQuickUpdate {
  ratePlanIds: string[]
  ranges: Array<{ from: string; to: string }>
  weekdays: QuickUpdateWeekday[]
  changes: QuickUpdateChanges
}

const asDate = (d: string): number | null => {
  if (!DAY.test(d)) return null
  const t = Date.parse(`${d}T00:00:00.000Z`)
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d ? null : t
}
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Validates the request shape. Unknown keys are rejected; values are never echoed. */
export function normaliseQuickUpdate(body: Partial<QuickUpdateRequest> | undefined): { value?: NormalisedQuickUpdate; errors: string[] } {
  const errors: string[] = []
  const b = (body ?? {}) as Record<string, unknown>
  for (const key of Object.keys(b)) if (!['scope', 'changes', 'idempotencyKey', 'expectedFingerprint', 'reason'].includes(key)) errors.push(`${key}: is not a supported field`)
  const scope = b.scope as Record<string, unknown> | undefined
  const changes = b.changes as Record<string, unknown> | undefined
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) errors.push('scope: is required')
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) errors.push('changes: is required')
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !changes || typeof changes !== 'object' || Array.isArray(changes)) return { errors }
  for (const key of Object.keys(scope!)) if (!['ratePlanIds', 'ranges', 'weekdays'].includes(key)) errors.push(`scope.${key}: is not a supported field`)

  const ids = scope!.ratePlanIds
  let ratePlanIds: string[] = []
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > QUICK_UPDATE_LIMITS.plans || !ids.every((i) => typeof i === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(i))) errors.push(`scope.ratePlanIds: choose 1 to ${QUICK_UPDATE_LIMITS.plans} rate plans`)
  else ratePlanIds = [...new Set(ids as string[])]

  const ranges: Array<{ from: string; to: string }> = []
  const rawRanges = scope!.ranges
  if (!Array.isArray(rawRanges) || rawRanges.length < 1 || rawRanges.length > QUICK_UPDATE_LIMITS.ranges) errors.push(`scope.ranges: provide 1 to ${QUICK_UPDATE_LIMITS.ranges} date ranges`)
  else {
    for (const [i, r] of rawRanges.entries()) {
      const from = typeof r?.from === 'string' ? asDate(r.from) : null; const to = typeof r?.to === 'string' ? asDate(r.to) : null
      if (from === null || to === null) { errors.push(`scope.ranges[${i}]: use real calendar dates (YYYY-MM-DD)`); continue }
      if (to < from) { errors.push(`scope.ranges[${i}]: the end date is before the start date`); continue }
      if ((to - from) / MS + 1 > QUICK_UPDATE_LIMITS.rangeDays) { errors.push(`scope.ranges[${i}]: at most ${QUICK_UPDATE_LIMITS.rangeDays} days per range`); continue }
      ranges.push({ from: r.from, to: r.to })
    }
  }

  let weekdays: QuickUpdateWeekday[] = []
  if (scope!.weekdays !== undefined) {
    if (!Array.isArray(scope!.weekdays) || !scope!.weekdays.every((w) => (QUICK_UPDATE_WEEKDAYS as readonly string[]).includes(w as string))) errors.push('scope.weekdays: use MON to SUN')
    else weekdays = [...new Set(scope!.weekdays as QuickUpdateWeekday[])]
  }

  const out: QuickUpdateChanges = {}
  for (const key of Object.keys(changes!)) if (!['price', 'availability', 'restrictions'].includes(key)) errors.push(`changes.${key}: is not a supported change`)
  const price = changes!.price as Record<string, unknown> | undefined
  if (price !== undefined) {
    for (const key of Object.keys(price ?? {})) if (!['amount', 'basis'].includes(key)) errors.push(`changes.price.${key}: is not a supported field`)
    if (typeof price?.amount !== 'string' || price.amount.trim() === '') errors.push('changes.price.amount: enter an amount, or leave the price panel untouched')
    else if (price.basis !== 'NET' && price.basis !== 'SELL') errors.push('changes.price.basis: choose NET or SELL')
    else out.price = { amount: price.amount.trim(), basis: price.basis }
  }
  const availability = changes!.availability as Record<string, unknown> | undefined
  if (availability !== undefined) {
    const a: NonNullable<QuickUpdateChanges['availability']> = {}
    for (const key of Object.keys(availability ?? {})) if (!['allotment', 'stopSell', 'mode'].includes(key)) errors.push(`changes.availability.${key}: is not a supported field`)
    if (availability?.allotment !== undefined) { if (!Number.isInteger(availability.allotment) || (availability.allotment as number) < 0 || (availability.allotment as number) > MAX_ALLOTMENT) errors.push(`changes.availability.allotment: a whole number from 0 to ${MAX_ALLOTMENT}`); else a.allotment = availability.allotment as number }
    if (availability?.stopSell !== undefined) { if (availability.stopSell !== 'SET' && availability.stopSell !== 'CLEAR') errors.push('changes.availability.stopSell: SET or CLEAR'); else a.stopSell = availability.stopSell }
    if (availability?.mode !== undefined) { if (typeof availability.mode !== 'string' || !(INVENTORY_MODES as readonly string[]).includes(availability.mode)) errors.push(`changes.availability.mode: one of ${INVENTORY_MODES.join(', ')}`); else a.mode = availability.mode as (typeof INVENTORY_MODES)[number] }
    if (Object.keys(a).length) out.availability = a
  }
  const restrictions = changes!.restrictions as Record<string, unknown> | undefined
  if (restrictions !== undefined) {
    const r: NonNullable<QuickUpdateChanges['restrictions']> = {}
    for (const key of Object.keys(restrictions ?? {})) if (!['minStay', 'closedToArrival', 'closedToDeparture'].includes(key)) errors.push(`changes.restrictions.${key}: is not a supported field`)
    if (restrictions?.minStay !== undefined) { if (!Number.isInteger(restrictions.minStay) || (restrictions.minStay as number) < 1 || (restrictions.minStay as number) > MAX_MIN_STAY) errors.push(`changes.restrictions.minStay: a whole number from 1 to ${MAX_MIN_STAY}`); else r.minStay = restrictions.minStay as number }
    if (restrictions?.closedToArrival !== undefined) { if (restrictions.closedToArrival !== 'SET' && restrictions.closedToArrival !== 'CLEAR') errors.push('changes.restrictions.closedToArrival: SET or CLEAR'); else r.closedToArrival = restrictions.closedToArrival }
    if (restrictions?.closedToDeparture !== undefined) { if (restrictions.closedToDeparture !== 'SET' && restrictions.closedToDeparture !== 'CLEAR') errors.push('changes.restrictions.closedToDeparture: SET or CLEAR'); else r.closedToDeparture = restrictions.closedToDeparture }
    if (Object.keys(r).length) out.restrictions = r
  }
  if (!out.price && !out.availability && !out.restrictions && !errors.some((e) => e.startsWith('changes'))) errors.push('changes: choose at least one field to change; untouched fields stay as they are')
  if (errors.length) return { errors }
  return { value: { ratePlanIds, ranges, weekdays, changes: out }, errors }
}

/** The dates the scope selects, ascending and unique, after the weekday filter. */
export function expandDates(ranges: Array<{ from: string; to: string }>, weekdays: QuickUpdateWeekday[]): string[] {
  const set = new Set<string>()
  for (const r of ranges) for (let t = asDate(r.from)!; t <= asDate(r.to)!; t += MS) {
    const wd = QUICK_UPDATE_WEEKDAYS[(new Date(t).getUTCDay() + 6) % 7]
    if (weekdays.length === 0 || weekdays.includes(wd)) set.add(isoDay(t))
  }
  return [...set].sort()
}

/** The calendar date in an IANA time zone. Release and past-date rules use the hotel's own day, not the server's. */
export function dayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export interface PlanInfo { id: string; status: string; currency: string; occupancy: number; contractFrom: string; contractTo: string; /** Set when the plan draws its stock from a shared pool. */ poolId?: string | null }
export interface RateState { amountMinor: bigint; basis: 'NET' | 'SELL' | null }
export interface AvailState { allotment: number; sold: number; held: number; stopSell: boolean; minStay: number; closedToArrival: boolean; closedToDeparture?: boolean; mode?: string }
export interface PoolDayState { capacity: number; sold: number; held: number }
export interface PlannedRow extends QuickUpdateRow {
  /** The values to write when the outcome is CHANGE. */
  nextRate: { amountMinor: bigint; basis: 'NET' | 'SELL' } | null
  nextAvail: { create: boolean; allotment: number; stopSell: boolean; minStay: number; closedToArrival: boolean; closedToDeparture: boolean; mode: string } | null
  /** Pool capacity to write for this plan's pool night. The same pool night appears on every pooled plan in scope and is written once. */
  nextPool: { poolId: string; create: boolean; capacity: number } | null
}

const WRITABLE_PLAN_STATUSES = new Set(['DRAFT', 'ACTIVE'])

export function planQuickUpdate(input: {
  value: NormalisedQuickUpdate
  plans: Map<string, PlanInfo>
  rates: Map<string, RateState>
  avail: Map<string, AvailState>
  /** Pool nights keyed `${poolId}:${date}`. Omitted means no pool data is loaded. */
  pools?: Map<string, PoolDayState>
  today: string
}): { dates: string[]; rows: PlannedRow[]; errors: string[]; counts: { records: number; willChange: number; unchanged: number; invalid: number } } {
  const { value, plans, rates, avail, today } = input
  const pools = input.pools ?? new Map<string, PoolDayState>()
  const errors: string[] = []
  for (const id of value.ratePlanIds) if (!plans.has(id)) errors.push('scope.ratePlanIds: a rate plan does not belong to this hotel')
  const dates = expandDates(value.ranges, value.weekdays)
  if (dates.length === 0) errors.push('scope: the selected ranges and weekdays contain no dates')
  if (errors.length === 0 && dates.length * value.ratePlanIds.length > QUICK_UPDATE_LIMITS.records) errors.push(`scope: ${dates.length * value.ratePlanIds.length} records exceed the limit of ${QUICK_UPDATE_LIMITS.records} per batch; narrow the dates or plans`)
  const priceChange = value.changes.price
  if (priceChange && new Set(value.ratePlanIds.map((id) => plans.get(id)?.currency)).size > 1) errors.push('scope: a price change needs rate plans in one currency, because one amount is entered; split the update by currency')
  if (errors.length) return { dates, rows: [], errors, counts: { records: 0, willChange: 0, unchanged: 0, invalid: 0 } }

  // A price is converted once per currency with the canonical money package; no floating point is involved.
  const minorByCurrency = new Map<string, { minor: bigint } | { error: string }>()
  const priceFor = (currency: string) => {
    if (!priceChange) return null
    if (!minorByCurrency.has(currency)) {
      try {
        const minor = BigInt(majorUnitsToMinor(priceChange.amount, currency))
        minorByCurrency.set(currency, minor <= 0n ? { error: 'the price must be greater than zero' } : minor > MAX_AMOUNT_MINOR ? { error: 'the price is above the accepted maximum' } : { minor })
      } catch (e) { minorByCurrency.set(currency, { error: (e as Error).message === 'Amount exceeds the currency scale' ? `the price has more decimal places than ${currency} allows` : `the price is not a valid ${currency} amount` }) }
    }
    return minorByCurrency.get(currency)!
  }

  const rows: PlannedRow[] = []
  for (const planId of value.ratePlanIds) {
    const plan = plans.get(planId)!
    for (const date of dates) {
      const key = `${planId}:${date}`
      const problems: string[] = []; const changes: QuickUpdateFieldChange[] = []
      let nextRate: PlannedRow['nextRate'] = null; let nextAvail: PlannedRow['nextAvail'] = null; let nextPool: PlannedRow['nextPool'] = null
      if (!WRITABLE_PLAN_STATUSES.has(plan.status)) problems.push(`the rate plan is ${plan.status} and cannot be changed`)
      if (date < today) problems.push(`${date} is before today in the hotel's time zone`)
      if (date < plan.contractFrom || date > plan.contractTo) problems.push('the date is outside the contract validity')

      if (priceChange) {
        const p = priceFor(plan.currency)!
        if ('error' in p) problems.push(p.error)
        else {
          const cur = rates.get(key)
          if (!cur || cur.amountMinor !== p.minor || cur.basis !== priceChange.basis) {
            nextRate = { amountMinor: p.minor, basis: priceChange.basis }
            changes.push({ field: 'price', from: cur ? cur.amountMinor.toString() : null, to: p.minor.toString(), currency: plan.currency })
          }
        }
      }

      const a = value.changes.availability; const r = value.changes.restrictions
      if (a || r) {
        const cur = avail.get(key)
        const wantsAllotment = a?.allotment !== undefined
        if (!cur && !wantsAllotment) problems.push('no inventory row exists for this night, so a stop-sell or restriction cannot be set; set an allotment first (missing inventory means unknown, not zero)')
        else {
          const next = { create: !cur, allotment: cur?.allotment ?? 0, stopSell: cur?.stopSell ?? false, minStay: cur?.minStay ?? 1, closedToArrival: cur?.closedToArrival ?? false, closedToDeparture: cur?.closedToDeparture ?? false, mode: cur?.mode ?? 'ALLOTMENT' }
          if (wantsAllotment && plan.poolId) {
            // A pooled plan has no count of its own: the value is the pool's capacity for the night.
            const poolDay = pools.get(`${plan.poolId}:${date}`)
            if (poolDay && a!.allotment! < poolDay.sold + poolDay.held) problems.push(`the pool capacity ${a!.allotment} is below the ${poolDay.sold + poolDay.held} already sold or held on the pool`)
            else {
              if (!poolDay || poolDay.capacity !== a!.allotment) changes.push({ field: 'poolCapacity', from: poolDay ? poolDay.capacity : null, to: a!.allotment! })
              nextPool = { poolId: plan.poolId, create: !poolDay, capacity: a!.allotment! }
            }
          } else if (wantsAllotment) {
            if (cur && a!.allotment! < cur.sold + cur.held) problems.push(`the allotment ${a!.allotment} is below the ${cur.sold + cur.held} already sold or held`)
            else { if (!cur || cur.allotment !== a!.allotment) changes.push({ field: 'allotment', from: cur ? cur.allotment : null, to: a!.allotment! }); next.allotment = a!.allotment! }
          }
          if (a?.stopSell) { const to = a.stopSell === 'SET'; if (!cur || cur.stopSell !== to) changes.push({ field: 'stopSell', from: cur ? cur.stopSell : null, to }); next.stopSell = to }
          if (a?.mode) { if (!cur || (cur.mode ?? 'ALLOTMENT') !== a.mode) changes.push({ field: 'inventoryMode', from: cur ? cur.mode ?? 'ALLOTMENT' : null, to: a.mode }); next.mode = a.mode }
          if (r?.minStay !== undefined) { if (!cur || cur.minStay !== r.minStay) changes.push({ field: 'minStay', from: cur ? cur.minStay : null, to: r.minStay }); next.minStay = r.minStay }
          if (r?.closedToArrival) { const to = r.closedToArrival === 'SET'; if (!cur || cur.closedToArrival !== to) changes.push({ field: 'closedToArrival', from: cur ? cur.closedToArrival : null, to }); next.closedToArrival = to }
          if (r?.closedToDeparture) { const to = r.closedToDeparture === 'SET'; if (!cur || (cur.closedToDeparture ?? false) !== to) changes.push({ field: 'closedToDeparture', from: cur ? cur.closedToDeparture ?? false : null, to }); next.closedToDeparture = to }
          // The plan row is written when a row-level field changed, or when the row does not exist yet (a pooled plan still needs its row for restrictions and mode).
          if (changes.some((c) => c.field !== 'price' && c.field !== 'poolCapacity') || (!cur && changes.some((c) => c.field === 'poolCapacity'))) nextAvail = next
        }
      }
      const outcome = problems.length ? 'INVALID' : changes.length ? 'CHANGE' : 'NO_CHANGE'
      rows.push({ ratePlanId: planId, date, outcome, problems, changes: problems.length ? [] : changes, nextRate: outcome === 'CHANGE' ? nextRate : null, nextAvail: outcome === 'CHANGE' ? nextAvail : null, nextPool: outcome === 'CHANGE' ? nextPool : null })
    }
  }
  const counts = { records: rows.length, willChange: rows.filter((x) => x.outcome === 'CHANGE').length, unchanged: rows.filter((x) => x.outcome === 'NO_CHANGE').length, invalid: rows.filter((x) => x.outcome === 'INVALID').length }
  return { dates, rows, errors, counts }
}
