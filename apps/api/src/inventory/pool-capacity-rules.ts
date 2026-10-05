import { createHash } from 'crypto'
import { POOL_CAPACITY_LIMITS, QUICK_UPDATE_WEEKDAYS, type PoolCapacityEditRequest, type PoolCapacityPreviewRow, type QuickUpdateWeekday } from '@bedbanks/contracts'
import { expandDates } from '../hotel-setup/quick-update-rules'

/**
 * Pure rules of the pool capacity editor (ADR 0036). No I/O, no clock: the hotel-local "today" is passed in.
 *
 * Capacity is the only thing this module plans. It never touches sold or held, never creates a hold, and never decides
 * availability: `available = capacity - sold - held` is the one expression the evaluator already uses.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const MS = 86_400_000
const asMs = (day: string): number | null => (ISO_DAY.test(day) && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day ? Date.parse(`${day}T00:00:00.000Z`) : null)

export interface NormalisedCapacityEdit { startDate: string; endDate: string; weekdays: QuickUpdateWeekday[]; capacity: number }
export interface PoolDayState { id: string; capacity: number; sold: number; held: number; updatedAt: Date }

/** Request-shape validation only. Returns a value when every field is acceptable, otherwise every problem found. */
export function normaliseCapacityEdit(body: Partial<PoolCapacityEditRequest> | null | undefined): { value: NormalisedCapacityEdit | null; errors: string[] } {
  const errors: string[] = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { value: null, errors: ['A request body is required'] }
  const start = typeof body.startDate === 'string' ? asMs(body.startDate) : null
  const end = typeof body.endDate === 'string' ? asMs(body.endDate) : null
  if (start === null) errors.push('startDate must be a real calendar date (YYYY-MM-DD)')
  if (end === null) errors.push('endDate must be a real calendar date (YYYY-MM-DD)')
  if (start !== null && end !== null) {
    if (end < start) errors.push('endDate must not be before startDate')
    else if ((end - start) / MS + 1 > POOL_CAPACITY_LIMITS.maxRangeDays) errors.push(`The range is limited to ${POOL_CAPACITY_LIMITS.maxRangeDays} nights`)
  }
  let weekdays: QuickUpdateWeekday[] = []
  if (body.weekdays !== undefined && body.weekdays !== null) {
    if (!Array.isArray(body.weekdays) || !body.weekdays.every((w) => (QUICK_UPDATE_WEEKDAYS as readonly string[]).includes(w as string))) errors.push('weekdays must use MON to SUN')
    else weekdays = [...new Set(body.weekdays as QuickUpdateWeekday[])]
  }
  const capacity = body.capacity
  if (capacity === null || capacity === undefined || (capacity as unknown) === '') errors.push('Enter a capacity. Blank means unchanged, so there is nothing to apply (zero is a valid capacity)')
  else if (typeof capacity !== 'number' || !Number.isInteger(capacity)) errors.push('capacity must be a whole number')
  else if (capacity < 0 || capacity > POOL_CAPACITY_LIMITS.maxCapacity) errors.push(`capacity must be from 0 to ${POOL_CAPACITY_LIMITS.maxCapacity}`)
  for (const key of Object.keys(body)) if (!['startDate', 'endDate', 'weekdays', 'capacity', 'expectedFingerprint', 'reason', 'idempotencyKey'].includes(key)) errors.push(`${key} is not a supported field`)
  if (errors.length) return { value: null, errors }
  return { value: { startDate: body.startDate as string, endDate: body.endDate as string, weekdays, capacity: capacity as number }, errors: [] }
}

export interface CapacityPlan {
  dates: string[]
  rows: Array<PoolCapacityPreviewRow & { id: string | null }>
  errors: string[]
  counts: { dates: number; willChange: number; willCreate: number; unchanged: number; invalid: number }
}

/**
 * Plans the edit against the loaded pool days. Rules:
 *  - a night before the hotel's local today is invalid (past nights are not editable);
 *  - a capacity below sold + held is invalid (units already committed are never removed or ignored);
 *  - a missing pool night is created only because the operator set an explicit capacity (unknown becomes a stated number, never an implied zero);
 *  - an equal capacity is unchanged.
 */
export function planCapacityEdit(value: NormalisedCapacityEdit, days: Map<string, PoolDayState>, today: string): CapacityPlan {
  const dates = expandDates([{ from: value.startDate, to: value.endDate }], value.weekdays)
  const errors: string[] = []
  if (dates.length === 0) errors.push('The selected range and weekdays contain no dates')
  const counts = { dates: dates.length, willChange: 0, willCreate: 0, unchanged: 0, invalid: 0 }
  const rows: CapacityPlan['rows'] = dates.map((date) => {
    const weekday = QUICK_UPDATE_WEEKDAYS[(new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7]
    const current = days.get(date)
    const before = current ? { capacity: current.capacity, sold: current.sold, held: current.held, available: current.capacity - current.sold - current.held } : null
    const problems: string[] = []
    if (date < today) problems.push(`${date} is before the hotel's local today (${today}), so it cannot be edited`)
    if (current && value.capacity < current.sold + current.held) problems.push(`capacity ${value.capacity} is below the ${current.sold + current.held} unit(s) already sold or held (sold ${current.sold}, held ${current.held})`)
    if (problems.length) { counts.invalid += 1; return { id: current?.id ?? null, date, weekday, before, after: null, outcome: 'INVALID' as const, problems } }
    if (!current) { counts.willCreate += 1; return { id: null, date, weekday, before: null, after: { capacity: value.capacity, available: value.capacity }, outcome: 'CREATE' as const, problems: [] } }
    if (current.capacity === value.capacity) { counts.unchanged += 1; return { id: current.id, date, weekday, before, after: { capacity: value.capacity, available: before!.available }, outcome: 'UNCHANGED' as const, problems: [] } }
    counts.willChange += 1
    return { id: current.id, date, weekday, before, after: { capacity: value.capacity, available: value.capacity - current.sold - current.held }, outcome: 'CHANGE' as const, problems: [] }
  })
  return { dates, rows, errors, counts }
}

/**
 * A digest of everything the preview depended on: the request, the pool's status, and for each selected night either its absence or its
 * capacity, sold, held and version. If any of it changes between preview and apply, the digests differ and the apply is refused.
 */
export function capacityFingerprint(input: { poolId: string; status: string; value: NormalisedCapacityEdit; dates: string[]; days: Map<string, PoolDayState> }): string {
  const lines = [`P|${input.poolId}|${input.status}`, `R|${input.value.startDate}|${input.value.endDate}|${[...input.value.weekdays].sort().join(',')}|${input.value.capacity}`]
  for (const date of input.dates) {
    const d = input.days.get(date)
    lines.push(d ? `D|${date}|${d.capacity}|${d.sold}|${d.held}|${d.updatedAt.getTime()}` : `M|${date}`)
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
