import { majorUnitsToMinor } from '@bedbanks/money'
import { isIsoDate, isOffsetTimestamp } from '../xml/supplier-types'
import type {
  CancellationPenalty, CancellationWindow, IngestAllotment, IngestCancellationPolicy, IngestInventoryMode, IngestRate,
  IngestRecordKind, IngestRejectCode, IngestReject, IngestResult, IngestStatus,
} from './canonical'
import type { RawRecord } from './extract'

export interface NormalizeOptions {
  /** Reject ratio (basis points of extracted records) above which the feed is FAILED rather than PARTIAL. Default 5000. */
  maxRejectBasisPoints?: number
  /** Stay dates outside [today, today + horizonDays] are rejected. */
  today: string
  horizonDays?: number
}
export interface CancellationOptions extends NormalizeOptions {
  /**
   * Supplier-declared local cut-off used when a rule is expressed as "N days before arrival". Offset like `+04:00`
   * and `HH:MM`. Operator configuration per supplier; there is no default, so a feed that needs it without it is rejected.
   */
  hotelUtcOffset?: string
  cutoffTime?: string
}

class Reject extends Error {
  constructor(readonly code: IngestRejectCode, readonly field: string | null) { super(code) }
}
const bad = (code: IngestRejectCode, field: string): never => { throw new Reject(code, field) }

const CODE = /^[A-Za-z0-9_.:\-/]{1,64}$/
const CURRENCY = /^[A-Z]{3}$/
const DEFAULT_HORIZON = 800
const DAY_MS = 86_400_000

function req(r: RawRecord, field: string): string {
  const v = r[field]
  return v === undefined ? bad('missing_field', field) : v
}
function code(r: RawRecord, field: string): string { const v = req(r, field); return CODE.test(v) ? v : bad('invalid_code', field) }
function optCode(r: RawRecord, field: string): string | null { const v = r[field]; return v === undefined ? null : CODE.test(v) ? v : bad('invalid_code', field) }
function currency(r: RawRecord, field: string): string { const v = req(r, field).toUpperCase(); return CURRENCY.test(v) ? v : bad('invalid_currency', field) }
function boolOpt(r: RawRecord, field: string): boolean | null {
  const v = r[field]
  if (v === undefined) return null
  const t = v.toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(t)) return true
  if (['false', '0', 'no', 'n'].includes(t)) return false
  return bad('invalid_flag', field)
}
function intOpt(r: RawRecord, field: string, min: number, max: number): number | null {
  const v = r[field]
  if (v === undefined) return null
  if (!/^\d{1,6}$/.test(v)) return bad('invalid_integer', field)
  const n = Number(v)
  return n >= min && n <= max ? n : bad('invalid_range', field)
}
function dayNumber(date: string): number { return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS) }
function stayDate(r: RawRecord, field: string, o: NormalizeOptions): string {
  const v = req(r, field)
  if (!isIsoDate(v)) return bad('invalid_date', field)
  const delta = dayNumber(v) - dayNumber(o.today)
  return delta >= 0 && delta <= (o.horizonDays ?? DEFAULT_HORIZON) ? v : bad('invalid_range', field)
}
function amount(v: string, cur: string, field: string, allowZero: boolean): number {
  let minor: number
  try { minor = majorUnitsToMinor(v, cur) } catch { return bad('invalid_amount', field) }
  return minor === 0 && !allowZero ? bad('invalid_amount', field) : minor
}
/** Decimal percent string (<= 2 fractional digits) to basis points through integers. 0..100 inclusive. */
function percentBasisPoints(v: string, field: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v)
  if (!m) return bad('invalid_amount', field)
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return bp <= 10_000 ? bp : bad('invalid_range', field)
}

function statusOf(total: number, accepted: number, rejected: number, maxRejectBasisPoints = 5_000): IngestStatus {
  if (total === 0 || accepted === 0) return 'FAILED'
  if (rejected === 0) return 'COMPLETE'
  return rejected * 10_000 > total * maxRejectBasisPoints ? 'FAILED' : 'PARTIAL'
}

function finish<T>(kind: IngestRecordKind, rows: readonly RawRecord[], map: (r: RawRecord) => T, keyOf: (v: T) => string, o: NormalizeOptions): IngestResult<T> {
  const accepted = new Map<string, { value: T; index: number; serial: string }>()
  const rejected: IngestReject[] = []
  const conflicted = new Set<string>()
  rows.forEach((row, index) => {
    try {
      const value = map(row)
      const key = keyOf(value)
      const serial = JSON.stringify(value)
      const prior = accepted.get(key)
      if (!prior) accepted.set(key, { value, index, serial })
      else if (prior.serial !== serial) { conflicted.add(key); rejected.push({ kind, index, code: 'duplicate_conflict', field: null }) }
    } catch (e) {
      if (!(e instanceof Reject)) throw e
      rejected.push({ kind, index, code: e.code, field: e.field })
    }
  })
  // Two contradictory rows for one key: neither is trusted, including the first one seen.
  for (const key of conflicted) {
    const prior = accepted.get(key)
    if (prior) { rejected.push({ kind, index: prior.index, code: 'duplicate_conflict', field: null }); accepted.delete(key) }
  }
  rejected.sort((a, b) => a.index - b.index)
  const status = statusOf(rows.length, accepted.size, rejected.length, o.maxRejectBasisPoints)
  return { accepted: [...accepted.values()].map((a) => a.value), rejected, extracted: rows.length, status }
}

export function normalizeRates(rows: readonly RawRecord[], o: NormalizeOptions): IngestResult<IngestRate> {
  return finish('rate', rows, (r) => {
    const cur = currency(r, 'currency')
    const minStay = intOpt(r, 'minStay', 1, 365)
    const maxStay = intOpt(r, 'maxStay', 1, 365)
    if (minStay !== null && maxStay !== null && maxStay < minStay) bad('invalid_range', 'maxStay')
    return {
      supplierHotelCode: code(r, 'hotelCode'), supplierRoomCode: code(r, 'roomCode'), supplierRatePlanCode: code(r, 'ratePlanCode'),
      boardCode: optCode(r, 'boardCode'), stayDate: stayDate(r, 'stayDate', o), currency: cur,
      netMinor: amount(req(r, 'netAmount'), cur, 'netAmount', false), taxesIncluded: boolOpt(r, 'taxesIncluded'),
      minStay, maxStay, closedToArrival: boolOpt(r, 'closedToArrival') ?? false, closedToDeparture: boolOpt(r, 'closedToDeparture') ?? false,
    }
  }, (v) => [v.supplierHotelCode, v.supplierRoomCode, v.supplierRatePlanCode, v.stayDate].join('|'), o)
}

const MODES: Record<string, IngestInventoryMode> = { allotment: 'ALLOTMENT', freesale: 'FREE_SALE', free_sale: 'FREE_SALE', onrequest: 'ON_REQUEST', on_request: 'ON_REQUEST', closed: 'CLOSED' }

export function normalizeAllotments(rows: readonly RawRecord[], o: NormalizeOptions): IngestResult<IngestAllotment> {
  return finish('allotment', rows, (r) => {
    const rawMode = r.mode?.toLowerCase().replace(/[\s-]/g, '_')
    // A feed that states only a count is an allotment; a feed with no count and no mode says nothing (ADR 0030 #4).
    const mode: IngestInventoryMode = rawMode === undefined ? (r.available !== undefined ? 'ALLOTMENT' : bad('missing_field', 'mode')) : (MODES[rawMode] ?? bad('invalid_flag', 'mode'))
    const available = intOpt(r, 'available', 0, 99_999)
    if (mode === 'ALLOTMENT' && available === null) bad('missing_field', 'available')
    return {
      supplierHotelCode: code(r, 'hotelCode'), supplierRoomCode: code(r, 'roomCode'), supplierRatePlanCode: optCode(r, 'ratePlanCode'),
      stayDate: stayDate(r, 'stayDate', o), mode, available: mode === 'ALLOTMENT' ? available : null,
      stopSell: boolOpt(r, 'stopSell') ?? false, releaseDays: intOpt(r, 'releaseDays', 0, 365),
    }
  }, (v) => [v.supplierHotelCode, v.supplierRoomCode, v.supplierRatePlanCode ?? '*', v.stayDate].join('|'), o)
}

function penaltyOf(r: RawRecord, cur: string | null): CancellationPenalty {
  const type = req(r, 'penaltyType').toLowerCase().replace(/[\s-]/g, '_')
  if (type === 'full' || type === 'full_stay' || type === 'non_refundable') return { type: 'FULL' }
  if (type === 'percent' || type === 'percentage') return { type: 'PERCENT', basisPoints: percentBasisPoints(req(r, 'penaltyValue'), 'penaltyValue') }
  if (type === 'nights' || type === 'night') {
    const n = intOpt(r, 'penaltyValue', 1, 365)
    return n === null ? bad('missing_field', 'penaltyValue') : { type: 'NIGHTS', nights: n }
  }
  if (type === 'fixed' || type === 'amount') {
    if (cur === null) return bad('missing_field', 'currency')
    return { type: 'FIXED', amountMinor: amount(req(r, 'penaltyValue'), cur, 'penaltyValue', false), currency: cur }
  }
  return bad('invalid_policy', 'penaltyType')
}

/** Resolve the window start to an offset-qualified instant. Exactly one of `from` or `daysBefore` + `arrivalDate`. */
function windowStart(r: RawRecord, o: CancellationOptions): string {
  if (r.from !== undefined) return isOffsetTimestamp(r.from) ? new Date(r.from).toISOString() : bad('invalid_date', 'from')
  const days = intOpt(r, 'daysBefore', 0, 730)
  if (days === null) return bad('missing_field', 'from')
  const arrival = req(r, 'arrivalDate')
  if (!isIsoDate(arrival)) return bad('invalid_date', 'arrivalDate')
  if (!o.hotelUtcOffset || !/^[+-]\d{2}:\d{2}$/.test(o.hotelUtcOffset) || !o.cutoffTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.cutoffTime)) return bad('invalid_policy', 'cutoffTime')
  const day = new Date(Date.parse(`${arrival}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)
  const stamp = `${day}T${o.cutoffTime}:00${o.hotelUtcOffset}`
  return isOffsetTimestamp(stamp) ? new Date(stamp).toISOString() : bad('invalid_date', 'from')
}

/**
 * Rows are one cancellation window each, grouped by hotel + (room) + rate plan. A plan whose rows disagree on
 * non-refundability, or whose windows are not strictly ordered, is rejected as a whole: a guessed policy is a mis-sold refund.
 */
export function normalizeCancellationPolicies(rows: readonly RawRecord[], o: CancellationOptions): IngestResult<IngestCancellationPolicy> {
  interface Group { hotel: string; room: string | null; plan: string; nonRefundable: boolean | null; windows: CancellationWindow[]; indices: number[]; invalid: boolean }
  const groups = new Map<string, Group>()
  const rejected: IngestReject[] = []
  rows.forEach((r, index) => {
    let key = ''
    try {
      const hotel = code(r, 'hotelCode'); const plan = code(r, 'ratePlanCode'); const room = optCode(r, 'roomCode')
      key = [hotel, room ?? '*', plan].join('|')
      const g = groups.get(key) ?? { hotel, room, plan, nonRefundable: null, windows: [], indices: [], invalid: false }
      groups.set(key, g)
      g.indices.push(index)
      const nr = boolOpt(r, 'nonRefundable')
      if (nr !== null) { if (g.nonRefundable !== null && g.nonRefundable !== nr) { g.invalid = true; bad('invalid_policy', 'nonRefundable') } g.nonRefundable = nr }
      if (r.penaltyType === undefined && nr === true) return
      const cur = r.currency === undefined ? null : currency(r, 'currency')
      g.windows.push({ from: windowStart(r, o), penalty: penaltyOf(r, cur) })
    } catch (e) {
      if (!(e instanceof Reject)) throw e
      rejected.push({ kind: 'cancellation', index, code: e.code, field: e.field })
      const g = groups.get(key); if (g) g.invalid = true
    }
  })
  const accepted: IngestCancellationPolicy[] = []
  for (const g of groups.values()) {
    const windows = [...g.windows].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
    const ordered = windows.every((w, i) => i === 0 || Date.parse(w.from) > Date.parse(windows[i - 1].from))
    const nonRefundable = g.nonRefundable ?? false
    // A row that says "non-refundable" but also lists a free window, or a refundable plan with no stated windows, is ambiguous.
    const consistent = nonRefundable ? windows.every((w) => w.penalty.type === 'FULL') : windows.length > 0
    if (g.invalid || !ordered || !consistent) {
      for (const i of g.indices) if (!rejected.some((x) => x.index === i)) rejected.push({ kind: 'cancellation', index: i, code: 'invalid_policy', field: null })
      continue
    }
    accepted.push({ supplierHotelCode: g.hotel, supplierRoomCode: g.room, supplierRatePlanCode: g.plan, nonRefundable, windows })
  }
  rejected.sort((a, b) => a.index - b.index)
  const status = statusOf(rows.length, accepted.length, rejected.length, o.maxRejectBasisPoints)
  return { accepted, rejected, extracted: rows.length, status }
}
