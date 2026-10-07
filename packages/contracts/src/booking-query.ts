/**
 * `BookingQueryV1`: the ONE grammar for selecting bookings (ADR 0039, Phase 6A). The Admin list, Saved Views, bulk-action target resolution, async export and
 * reconciliation drill-down all consume this, so no feature invents its own filtering. Pure and transport-agnostic: no Nest, no Prisma, no clock.
 *
 * The wire form is a flat record of strings (the URL query string). `normalizeBookingQuery` validates every field, rejects anything it does not know
 * (a typo or a field from a newer client is a 400, never silently ignored or widened), collects ALL errors, and returns the canonical object. The same
 * query always normalizes to the same object and the same `bookingQueryKey`, whatever the order, case of enum words, duplicates or defaults in the input.
 *
 * What it is not: an authorization policy. Row scope (tenant, agency) and field visibility are applied by the server from the authenticated session,
 * after normalization, every time a query runs. A saved or shared query can therefore never carry more visibility than its caller has.
 */
import {
  BOOKING_DATE_TYPES, BOOKING_PAGE_SIZES, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_STATUSES, BOOKING_QUICK_SEARCHES, BOOKING_SORTS, BOOKING_UNASSIGNED_AGENCY,
  type BookingDateType, type BookingQuickSearch, type BookingSort,
} from './booking-ops'
import { BOOKING_STATUSES, type BookingStatus } from './operations'
import { BOOKING_FINANCE_EVENT_TYPES, type BookingFinanceEventType } from './booking-finance'

export const BOOKING_QUERY_VERSION = 1
export const BOOKING_SOURCES = ['PORTAL', 'API', 'MANUAL'] as const
export type BookingSource = (typeof BOOKING_SOURCES)[number]
/** Date columns a range can apply to. `updated` is new in Phase 6. */
export const BOOKING_QUERY_DATE_TYPES = [...BOOKING_DATE_TYPES, 'updated'] as const
export type BookingQueryDateType = BookingDateType | 'updated'
export const BOOKING_QUERY_MAX_AGENCIES = 25
/** Page sizes accepted for an interactive list. Export and bulk resolution use their own capped, keyset paths and do not use these. */
export const BOOKING_QUERY_PAGE_SIZES = BOOKING_PAGE_SIZES

/** Every key the grammar accepts, in canonical order. Anything else is rejected. */
export const BOOKING_QUERY_FIELDS = [
  'chip', 'reference', 'guest', 'agencyId', 'supplier', 'hotelId', 'hotel', 'destination', 'status', 'supplierStatus',
  'dateType', 'from', 'to', 'paymentMode', 'paymentStatus', 'source', 'currency', 'amountMin', 'amountMax', 'opsOwner', 'moneyEvent',
  'missingSupplierRef', 'nonRefundable', 'amended', 'attention', 'sort', 'dir',
] as const
export type BookingQueryField = (typeof BOOKING_QUERY_FIELDS)[number]
const PAGING_FIELDS = ['page', 'pageSize'] as const

export interface BookingQueryV1 {
  v: 1
  chip: BookingQuickSearch | null
  reference: string | null
  guest: string | null
  /** Sorted, unique. May contain `BOOKING_UNASSIGNED_AGENCY`. */
  agencyIds: string[]
  supplier: string | null
  hotelId: string | null
  hotel: string | null
  destination: string | null
  /** Sorted in lifecycle order, unique. */
  statuses: BookingStatus[]
  supplierStatus: string | null
  dateType: BookingQueryDateType | null
  from: string | null
  to: string | null
  paymentMode: string | null
  paymentStatus: string | null
  source: BookingSource | null
  currency: string | null
  /** Integer minor units as digits; only valid together with `currency`. */
  amountMin: string | null
  amountMax: string | null
  /** A user id, or `BOOKING_UNASSIGNED_AGENCY` ("unassigned") for cases with no operations owner. */
  opsOwner: string | null
  moneyEvent: BookingFinanceEventType | null
  missingSupplierRef: boolean
  nonRefundable: boolean
  amended: boolean
  attention: boolean
  sort: BookingSort
  dir: 'asc' | 'desc'
}
export interface BookingPageV1 { page: number; pageSize: number }

export interface BookingQueryIssue { field: string; code: 'UNSUPPORTED_FIELD' | 'INVALID_VALUE' | 'INCOMPATIBLE'; message: string }
export type BookingQueryResult = { ok: true; query: BookingQueryV1; page: BookingPageV1 } | { ok: false; issues: BookingQueryIssue[] }

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REFERENCE = /^[A-Za-z0-9._\- /]{1,64}$/
const MINOR = /^\d{1,15}$/
const CURRENCY = /^[A-Z]{3}$/
const CONTROL = /[\u0000-\u001f]/

/** Default sort of a chip when the caller does not choose one. Owned here so every consumer orders identically. */
export const BOOKING_CHIP_SORT: Readonly<Record<BookingQuickSearch, { sort: BookingSort; dir: 'asc' | 'desc' }>> = {
  needsAction: { sort: 'created', dir: 'asc' }, latest: { sort: 'created', dir: 'desc' }, checkInNext7: { sort: 'checkIn', dir: 'asc' }, missingSupplierRef: { sort: 'created', dir: 'asc' },
  deadline48h: { sort: 'deadline', dir: 'asc' }, failed: { sort: 'created', dir: 'desc' }, latestCancelled: { sort: 'created', dir: 'desc' }, onRequest: { sort: 'created', dir: 'asc' },
  unpaid: { sort: 'created', dir: 'asc' }, noShowCandidates: { sort: 'checkIn', dir: 'desc' },
}
export const BOOKING_DEFAULT_SORT = { sort: 'created', dir: 'desc' } as const satisfies { sort: BookingSort; dir: 'asc' | 'desc' }
export const defaultSortFor = (chip: BookingQuickSearch | null) => (chip ? BOOKING_CHIP_SORT[chip] : BOOKING_DEFAULT_SORT)

function validDay(value: string): boolean {
  if (!DAY.test(value)) return false
  const d = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function normalizeBookingQuery(raw: Record<string, unknown>): BookingQueryResult {
  const issues: BookingQueryIssue[] = []
  const bad = (field: string, message: string, code: BookingQueryIssue['code'] = 'INVALID_VALUE') => { issues.push({ field, code, message }) }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, issues: [{ field: '*', code: 'INVALID_VALUE', message: 'A query must be an object of simple values' }] }

  for (const key of Object.keys(raw)) {
    if (!(BOOKING_QUERY_FIELDS as readonly string[]).includes(key) && !(PAGING_FIELDS as readonly string[]).includes(key)) bad(key, `Unsupported field "${key.slice(0, 40)}"`, 'UNSUPPORTED_FIELD')
  }
  /** One simple value, or none. Arrays and objects are never accepted. */
  const read = (field: string): string | undefined => {
    const v = raw[field]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v !== 'string') { bad(field, `${field} must be a single value`); return undefined }
    return v
  }
  const text = (field: string, max: number, min = 1): string | null => {
    const v = read(field)?.trim()
    if (!v) return null
    if (v.length > max || CONTROL.test(v)) { bad(field, `${field} is too long or has control characters (max ${max})`); return null }
    if (v.length < min) { bad(field, `${field} needs at least ${min} characters`); return null }
    return v
  }
  const id = (field: string): string | null => { const v = read(field); if (v === undefined) return null; if (!IDENTIFIER.test(v)) { bad(field, `Invalid ${field}`); return null } return v }
  const oneOf = <T extends string>(field: string, allowed: readonly T[]): T | null => { const v = read(field); if (v === undefined) return null; if (!(allowed as readonly string[]).includes(v)) { bad(field, `Invalid ${field}`); return null } return v as T }
  const flag = (field: string): boolean => { const v = read(field); if (v === undefined) return false; if (v === 'true') return true; if (v === 'false') return false; bad(field, `${field} must be true or false`); return false }
  const list = (field: string): string[] => { const v = read(field); return v === undefined ? [] : v.split(',').map((s) => s.trim()).filter(Boolean) }

  const chip = oneOf('chip', BOOKING_QUICK_SEARCHES)
  const reference = text('reference', 64); if (reference !== null && !REFERENCE.test(reference)) bad('reference', 'Invalid reference')
  const guest = text('guest', 60, 2)
  const hotel = text('hotel', 60, 2)
  const destination = text('destination', 60, 2)
  const supplier = text('supplier', 64)
  const supplierStatus = text('supplierStatus', 40)
  const hotelId = id('hotelId')

  const agencies = list('agencyId')
  if (agencies.length > BOOKING_QUERY_MAX_AGENCIES) bad('agencyId', `At most ${BOOKING_QUERY_MAX_AGENCIES} agencies`)
  for (const a of agencies) if (a !== BOOKING_UNASSIGNED_AGENCY && !IDENTIFIER.test(a)) bad('agencyId', 'Invalid agencyId')

  const statusWords = list('status')
  const statuses = [...new Set(statusWords)].filter((s): s is BookingStatus => { const ok = (BOOKING_STATUSES as readonly string[]).includes(s); if (!ok) bad('status', 'Invalid status'); return ok })

  const from = read('from'); const to = read('to')
  if (from !== undefined && !validDay(from)) bad('from', 'from must be a real date as YYYY-MM-DD')
  if (to !== undefined && !validDay(to)) bad('to', 'to must be a real date as YYYY-MM-DD')
  if (from && to && validDay(from) && validDay(to) && from > to) bad('from', 'from must not be after to', 'INCOMPATIBLE')
  const dateTypeIn = oneOf('dateType', BOOKING_QUERY_DATE_TYPES)
  const hasRange = Boolean(from || to)
  // A date type with no range means nothing; the canonical form drops it so equal queries stay equal.
  const dateType: BookingQueryDateType | null = hasRange ? dateTypeIn ?? 'created' : null

  const paymentMode = oneOf('paymentMode', BOOKING_PAYMENT_MODES)
  const paymentStatus = oneOf('paymentStatus', BOOKING_PAYMENT_STATUSES)
  const source = oneOf('source', BOOKING_SOURCES)
  const moneyEvent = oneOf('moneyEvent', BOOKING_FINANCE_EVENT_TYPES)

  const currency = read('currency'); if (currency !== undefined && !CURRENCY.test(currency)) bad('currency', 'currency must be an ISO-4217 code in capitals')
  const amountMin = read('amountMin'); const amountMax = read('amountMax')
  for (const [f, v] of [['amountMin', amountMin], ['amountMax', amountMax]] as const) if (v !== undefined && !MINOR.test(v)) bad(f, `${f} must be whole minor units (digits only)`)
  if ((amountMin !== undefined || amountMax !== undefined) && currency === undefined) bad('currency', 'An amount range needs a currency: amounts in different currencies are not comparable', 'INCOMPATIBLE')
  if (amountMin !== undefined && amountMax !== undefined && MINOR.test(amountMin) && MINOR.test(amountMax) && BigInt(amountMin) > BigInt(amountMax)) bad('amountMin', 'amountMin must not exceed amountMax', 'INCOMPATIBLE')

  const opsOwner = id('opsOwner')
  const chipDefault = defaultSortFor(chip)
  const sort = oneOf('sort', BOOKING_SORTS) ?? chipDefault.sort
  const dir = oneOf('dir', ['asc', 'desc'] as const) ?? chipDefault.dir

  const pageSizeRaw = read('pageSize'); const pageRaw = read('page')
  const pageSize = pageSizeRaw === undefined ? 25 : Number(pageSizeRaw)
  if (!(BOOKING_QUERY_PAGE_SIZES as readonly number[]).includes(pageSize)) bad('pageSize', 'Invalid pageSize (25, 50 or 100)')
  const page = pageRaw === undefined ? 1 : Number(pageRaw)
  if (!Number.isInteger(page) || page < 1 || page > 100_000) bad('page', 'Invalid page')

  const flags = { missingSupplierRef: flag('missingSupplierRef'), nonRefundable: flag('nonRefundable'), amended: flag('amended'), attention: flag('attention') }
  if (issues.length) return { ok: false, issues }
  const statusOrder = new Map(BOOKING_STATUSES.map((s, i) => [s, i] as const))
  return {
    ok: true,
    page: { page, pageSize },
    query: {
      v: 1, chip, reference, guest, agencyIds: [...new Set(agencies)].sort(), supplier, hotelId, hotel, destination,
      statuses: statuses.sort((a, b) => (statusOrder.get(a) ?? 0) - (statusOrder.get(b) ?? 0)), supplierStatus,
      dateType, from: from ?? null, to: to ?? null, paymentMode, paymentStatus, source, currency: currency ?? null, amountMin: amountMin ?? null, amountMax: amountMax ?? null,
      opsOwner, moneyEvent, ...flags, sort, dir,
    },
  }
}

/** The canonical flat record: only what differs from "no filter", keys in grammar order, sort and direction only when not the chip's default. */
export function bookingQueryToParams(query: BookingQueryV1, options: { includeSort?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: BookingQueryField, v: string | null | boolean) => { if (v !== null && v !== false && v !== '') out[k] = v === true ? 'true' : String(v) }
  put('chip', query.chip); put('reference', query.reference); put('guest', query.guest)
  put('agencyId', query.agencyIds.length ? query.agencyIds.join(',') : null)
  put('supplier', query.supplier); put('hotelId', query.hotelId); put('hotel', query.hotel); put('destination', query.destination)
  put('status', query.statuses.length ? query.statuses.join(',') : null); put('supplierStatus', query.supplierStatus)
  put('dateType', query.dateType); put('from', query.from); put('to', query.to)
  put('paymentMode', query.paymentMode); put('paymentStatus', query.paymentStatus); put('source', query.source)
  put('currency', query.currency); put('amountMin', query.amountMin); put('amountMax', query.amountMax); put('opsOwner', query.opsOwner); put('moneyEvent', query.moneyEvent)
  put('missingSupplierRef', query.missingSupplierRef); put('nonRefundable', query.nonRefundable); put('amended', query.amended); put('attention', query.attention)
  const base = defaultSortFor(query.chip)
  if (options.includeSort !== false) { if (query.sort !== base.sort) out.sort = query.sort; if (query.dir !== base.dir) out.dir = query.dir }
  return out
}

/** A stable identity of the normalized query (sort included, paging excluded): equal queries give equal keys. */
export function bookingQueryKey(query: BookingQueryV1): string {
  const p = bookingQueryToParams(query)
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))
}

/** Re-normalizes an already-canonical record (for example a stored view) under the CURRENT grammar. */
export const renormalizeBookingQuery = (params: Record<string, unknown>): BookingQueryResult => normalizeBookingQuery(params)
