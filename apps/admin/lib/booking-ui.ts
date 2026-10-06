import {
  BOOKING_DATE_TYPES, BOOKING_PAGE_SIZES, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_STATUSES, BOOKING_QUICK_SEARCHES, BOOKING_SORTS, BOOKING_STATUSES,
  type BookingDateType, type BookingListQuery, type BookingQuickSearch, type BookingSort, type BookingStatus,
} from '@bedbanks/contracts'

/**
 * Display and URL helpers for the Admin bookings list (ADR 0039). Nothing here decides a status, a scope or a permission: filters are sent to the API,
 * which validates and applies them. These functions only read and write the URL, label values and remember which columns a person shows.
 */

export const statusLabel = (status: string): string => status.replace(/_/g, ' ')

const csv = (value: string | null): string[] => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean)
const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => (value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)

/** The filter keys that live in the URL, in a stable order so a shared link is identical however it was built. */
export const BOOKING_QUERY_KEYS = ['chip', 'reference', 'guest', 'agencyId', 'supplier', 'hotel', 'status', 'supplierStatus', 'dateType', 'from', 'to', 'paymentMode', 'paymentStatus', 'missingSupplierRef', 'nonRefundable', 'amended', 'attention', 'sort', 'dir', 'page', 'pageSize'] as const

/** Reads the URL into a query. Unknown or malformed values are dropped (the API would reject them), never carried along. */
export function readBookingQuery(params: URLSearchParams): BookingListQuery {
  const text = (key: string, max = 64): string | undefined => { const v = (params.get(key) ?? '').trim(); return v && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : undefined }
  const flag = (key: string): true | undefined => (params.get(key) === 'true' ? true : undefined)
  const size = Number(params.get('pageSize'))
  const page = Number(params.get('page'))
  const day = (key: string): string | undefined => { const v = params.get(key); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined }
  const statuses = csv(params.get('status')).filter((s): s is BookingStatus => (BOOKING_STATUSES as readonly string[]).includes(s))
  return {
    chip: oneOf(params.get('chip'), BOOKING_QUICK_SEARCHES), reference: text('reference'), guest: text('guest', 60), agencyId: text('agencyId', 400), supplier: text('supplier'), hotel: text('hotel', 60),
    status: statuses.length ? statuses.join(',') : undefined, supplierStatus: text('supplierStatus', 40), dateType: oneOf(params.get('dateType'), BOOKING_DATE_TYPES),
    from: day('from'), to: day('to'), paymentMode: oneOf(params.get('paymentMode'), BOOKING_PAYMENT_MODES), paymentStatus: oneOf(params.get('paymentStatus'), BOOKING_PAYMENT_STATUSES),
    missingSupplierRef: flag('missingSupplierRef'), nonRefundable: flag('nonRefundable'), amended: flag('amended'), attention: flag('attention'),
    sort: oneOf(params.get('sort'), BOOKING_SORTS), dir: oneOf(params.get('dir'), ['asc', 'desc'] as const),
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    pageSize: (BOOKING_PAGE_SIZES as readonly number[]).includes(size) && size !== 25 ? size : undefined,
  }
}

/** True when the URL asks for any filter other than a chip, paging or sorting. */
export const hasFilters = (q: BookingListQuery): boolean => Boolean(q.reference || q.guest || q.agencyId || q.supplier || q.hotel || q.status || q.supplierStatus || ((q.from || q.to) && q.dateType !== undefined) || q.from || q.to || q.paymentMode || q.paymentStatus || q.missingSupplierRef || q.nonRefundable || q.amended || q.attention)

/** The page opens on Needs action (spec); once the person asks for anything else, that is what they get. */
export function effectiveChip(q: BookingListQuery): BookingQuickSearch | undefined {
  return q.chip ?? (hasFilters(q) ? undefined : 'needsAction')
}

/** Query string for the API and the URL: defined, non-default values only, in a stable order. */
export function bookingQueryString(q: BookingListQuery): string {
  const out = new URLSearchParams()
  for (const key of BOOKING_QUERY_KEYS) {
    const value = (q as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '' || value === false) continue
    out.set(key, String(value))
  }
  const text = out.toString()
  return text ? `?${text}` : ''
}

export const bookingHref = (q: BookingListQuery): string => `/bookings${bookingQueryString(q)}`

/** A change to the filters always returns to page 1 so a page past the end can never be requested by accident. */
export function withFilters(current: BookingListQuery, change: Partial<BookingListQuery>): BookingListQuery {
  return { ...current, ...change, page: undefined }
}

// ---- time ------------------------------------------------------------------------------------------------------------------
/** A UTC instant shown in a named IANA zone with its label, or in UTC when the zone is unknown. Never in the viewer's own zone, so two operators read the same time. */
export function formatInZone(iso: string | null, timeZone: string | null, options: { dateOnly?: boolean } = {}): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const zone = timeZone && isZone(timeZone) ? timeZone : 'UTC'
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: 'short', year: 'numeric', ...(options.dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(date)
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? zone
  return `${text} ${label}`
}
function isZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true } catch { return false }
}

/** A free-cancellation deadline within 48 hours is shown in the warning colour. Past deadlines are not "soon". */
export function deadlineUrgency(iso: string | null, now: Date): 'none' | 'soon' | 'passed' {
  if (!iso) return 'none'
  const ms = Date.parse(iso) - now.getTime()
  if (Number.isNaN(ms)) return 'none'
  return ms < 0 ? 'passed' : ms <= 48 * 3_600_000 ? 'soon' : 'none'
}

// ---- columns ---------------------------------------------------------------------------------------------------------------
export const BOOKING_COLUMN_IDS = ['reference', 'status', 'agency', 'supplier', 'guest', 'hotel', 'stay', 'booked', 'deadline', 'amount', 'actions'] as const
export type BookingColumnId = (typeof BOOKING_COLUMN_IDS)[number]
export const BOOKING_COLUMN_LABEL: Record<BookingColumnId, string> = {
  reference: 'Booking #', status: 'Status', agency: 'Agency / Agent', supplier: 'Supplier / Supplier ref', guest: 'Lead guest', hotel: 'Hotel / Room', stay: 'Stay', booked: 'Booked on', deadline: 'Deadline', amount: 'Sell / Net', actions: 'Actions',
}
/** Booking # and Actions cannot be hidden: a row without them cannot be opened. */
export const BOOKING_COLUMNS_REQUIRED: readonly BookingColumnId[] = ['reference', 'actions']
export const DEFAULT_BOOKING_COLUMNS: readonly BookingColumnId[] = BOOKING_COLUMN_IDS
export const BOOKING_COLUMNS_STORAGE_KEY = 'fbeds.admin.bookings.columns.v1'

/** Validates a stored column list: known ids only, no duplicates, required columns present. Anything else falls back to the default. */
export function normalizeColumns(value: unknown): BookingColumnId[] {
  if (!Array.isArray(value)) return [...DEFAULT_BOOKING_COLUMNS]
  const known = new Set<string>(BOOKING_COLUMN_IDS)
  const seen = new Set<string>()
  const list = value.filter((v): v is BookingColumnId => typeof v === 'string' && known.has(v) && !seen.has(v) && (seen.add(v), true))
  for (const required of BOOKING_COLUMNS_REQUIRED) if (!list.includes(required)) list.push(required)
  // Actions always last, Booking # always first.
  const rest = list.filter((c) => c !== 'reference' && c !== 'actions')
  return ['reference', ...rest, 'actions']
}

export function moveColumn(columns: readonly BookingColumnId[], id: BookingColumnId, direction: -1 | 1): BookingColumnId[] {
  const list = [...columns]
  const index = list.indexOf(id)
  const target = index + direction
  // Booking # stays first and Actions last, so the movable range is the columns between them.
  if (index < 0 || id === 'reference' || id === 'actions' || target < 1 || target > list.length - 2) return list
  ;[list[index], list[target]] = [list[target], list[index]]
  return list
}

export function toggleColumn(columns: readonly BookingColumnId[], id: BookingColumnId): BookingColumnId[] {
  if (BOOKING_COLUMNS_REQUIRED.includes(id)) return [...columns]
  if (columns.includes(id)) return columns.filter((c) => c !== id)
  const list = [...columns]
  list.splice(list.length - 1, 0, id) // before Actions
  return list
}

export type { BookingDateType, BookingSort }
