/**
 * Saved Views of the booking list (ADR 0039, Phase 6B). A saved view is a PREFERENCE: a name, a canonical `BookingQueryV1` (filters and sort), and optionally a
 * column list. It is never a security policy: it carries no tenant, no user, no permission and no executable fragment, and it is re-validated against the CURRENT
 * grammar and the CURRENT caller's access every time it is opened, so an old view can never bypass a newer rule.
 * Pure and shared by the API (which enforces) and the Admin (which only displays).
 */
import { bookingQueryToParams, normalizeBookingQuery, type BookingQueryIssue } from './booking-query'

export const SAVED_VIEW_FILTER_VERSION = 1
export const SAVED_VIEW_NAME_MAX = 60
export const SAVED_VIEW_DESCRIPTION_MAX = 200
export const SAVED_VIEW_MAX_PER_USER = 50
/** The columns of the booking table. Single source for the Admin picker and for validating a saved column list. */
export const BOOKING_COLUMN_IDS = ['reference', 'status', 'agency', 'supplier', 'guest', 'hotel', 'stay', 'booked', 'deadline', 'amount', 'actions'] as const
export type BookingColumnId = (typeof BOOKING_COLUMN_IDS)[number]

export interface SavedViewSort { sort: string; dir: 'asc' | 'desc' }
/** What opening a view resolves to under the current grammar and the current caller. */
export type SavedViewResolution =
  | { status: 'ok'; params: Record<string, string> }
  | { status: 'stale' | 'restricted'; issues: BookingQueryIssue[] }

export interface BookingSavedViewView {
  id: string
  name: string
  description: string | null
  filterVersion: number
  /** The stored filters (canonical parameters, no sort or paging). */
  filters: Record<string, string>
  sort: SavedViewSort
  visibleColumns: BookingColumnId[] | null
  isDefault: boolean
  /** Optimistic version; send it back on update. */
  version: number
  createdAt: string
  updatedAt: string
  resolution: SavedViewResolution
}
export interface BookingSavedViewList { items: BookingSavedViewView[]; max: number }
export interface SavedViewWriteRequest {
  name: string
  description?: string | null
  /** Canonical booking-query parameters, WITHOUT sort, direction or paging. */
  filters: Record<string, unknown>
  sort?: { sort?: string; dir?: string }
  visibleColumns?: string[] | null
}
export interface SavedViewUpdateRequest extends Partial<SavedViewWriteRequest> { expectedVersion: number }
export interface SavedViewWriteResult { id: string; version: number; isDefault: boolean }
export const SAVED_VIEW_FAILURE = { notFound: 'SAVED_VIEW_NOT_FOUND', nameTaken: 'SAVED_VIEW_NAME_TAKEN', limit: 'SAVED_VIEW_LIMIT', stale: 'SAVED_VIEW_STALE', forbidden: 'SAVED_VIEW_FORBIDDEN', invalid: 'SAVED_VIEW_INVALID' } as const

export interface ValidSavedView {
  name: string
  nameKey: string
  description: string | null
  filterVersion: number
  filters: Record<string, string>
  sort: SavedViewSort
  visibleColumns: BookingColumnId[] | null
}
export type SavedViewInputResult = { ok: true; value: ValidSavedView } | { ok: false; issues: BookingQueryIssue[] }

const CONTROL = /[\u0000-\u001f\u007f]/
/** A name as stored: trimmed, inner whitespace collapsed, NFC. Case is kept for display; `nameKey` (lower case) is what must be unique per person. */
export function normalizeViewName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim()
  return name.length >= 1 && name.length <= SAVED_VIEW_NAME_MAX && !CONTROL.test(name) ? name : null
}

/** Columns: known ids only, no duplicates, Booking # first and Actions last. null means "the person's own column choice". */
export function normalizeViewColumns(value: unknown): BookingColumnId[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > BOOKING_COLUMN_IDS.length) return undefined
  const seen = new Set<string>()
  for (const v of value) if (typeof v !== 'string' || !(BOOKING_COLUMN_IDS as readonly string[]).includes(v) || seen.has(v)) return undefined; else seen.add(v)
  const middle = (value as BookingColumnId[]).filter((c) => c !== 'reference' && c !== 'actions')
  return ['reference', ...middle, 'actions']
}

/** Validates a create body or the full merged state of an update. Every problem is reported at once. */
export function normalizeSavedViewInput(body: unknown): SavedViewInputResult {
  const issues: BookingQueryIssue[] = []
  const bad = (field: string, message: string) => { issues.push({ field, code: 'INVALID_VALUE', message }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, issues: [{ field: '*', code: 'INVALID_VALUE', message: 'A request body is required' }] }
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) if (!['name', 'description', 'filters', 'sort', 'visibleColumns', 'expectedVersion'].includes(key)) issues.push({ field: key, code: 'UNSUPPORTED_FIELD', message: `Unsupported field "${key.slice(0, 40)}"` })
  const name = normalizeViewName(b.name)
  if (name === null) bad('name', `A name of 1 to ${SAVED_VIEW_NAME_MAX} characters, without control characters, is required`)
  let description: string | null = null
  if (b.description !== undefined && b.description !== null && b.description !== '') {
    if (typeof b.description !== 'string' || b.description.length > SAVED_VIEW_DESCRIPTION_MAX || CONTROL.test(b.description.replace(/\n/g, ' '))) bad('description', `A description of at most ${SAVED_VIEW_DESCRIPTION_MAX} characters`)
    else description = b.description.trim() || null
  }
  const filtersIn = b.filters
  let filters: Record<string, string> = {}
  let sort: SavedViewSort = { sort: 'created', dir: 'desc' }
  if (filtersIn === null || typeof filtersIn !== 'object' || Array.isArray(filtersIn)) bad('filters', 'filters must be an object of canonical booking-query parameters')
  else {
    const f = filtersIn as Record<string, unknown>
    for (const key of ['sort', 'dir', 'page', 'pageSize']) if (key in f) bad('filters', `"${key}" does not belong in filters: sort goes in "sort", and paging is never saved`)
    const s = b.sort === undefined || b.sort === null ? {} : b.sort
    if (typeof s !== 'object' || Array.isArray(s)) bad('sort', 'sort must be an object')
    else {
      const r = normalizeBookingQuery({ ...f, ...((s as { sort?: unknown }).sort !== undefined ? { sort: (s as { sort: unknown }).sort } : {}), ...((s as { dir?: unknown }).dir !== undefined ? { dir: (s as { dir: unknown }).dir } : {}) })
      if (!r.ok) issues.push(...r.issues)
      else { filters = bookingQueryToParams(r.query, { includeSort: false }); sort = { sort: r.query.sort, dir: r.query.dir } }
    }
  }
  const columns = b.visibleColumns === undefined ? null : normalizeViewColumns(b.visibleColumns)
  if (columns === undefined) bad('visibleColumns', 'visibleColumns must list known column ids once each, or be null')
  if (issues.length || name === null) return { ok: false, issues }
  return { ok: true, value: { name, nameKey: name.toLowerCase(), description, filterVersion: SAVED_VIEW_FILTER_VERSION, filters, sort, visibleColumns: columns ?? null } }
}

/**
 * Opens a stored view under the CURRENT grammar. `restrictedBy` is the caller's access check (supplied by the API): a field the caller may no longer use makes the
 * view `restricted`, not silently widened or narrowed. A grammar the server no longer accepts makes it `stale`.
 */
export function resolveSavedView(stored: { filterVersion: number; filters: unknown; sort: unknown }, restrictedBy?: (query: import('./booking-query').BookingQueryV1) => BookingQueryIssue[]): SavedViewResolution {
  if (stored.filterVersion !== SAVED_VIEW_FILTER_VERSION) return { status: 'stale', issues: [{ field: '*', code: 'INVALID_VALUE', message: `This view uses filter version ${stored.filterVersion}, which this server no longer reads` }] }
  const f = stored.filters && typeof stored.filters === 'object' && !Array.isArray(stored.filters) ? (stored.filters as Record<string, unknown>) : null
  const s = stored.sort && typeof stored.sort === 'object' && !Array.isArray(stored.sort) ? (stored.sort as { sort?: unknown; dir?: unknown }) : {}
  if (!f) return { status: 'stale', issues: [{ field: 'filters', code: 'INVALID_VALUE', message: 'The stored filters are unreadable' }] }
  const r = normalizeBookingQuery({ ...f, ...(s.sort !== undefined ? { sort: s.sort } : {}), ...(s.dir !== undefined ? { dir: s.dir } : {}) })
  if (!r.ok) return { status: 'stale', issues: r.issues }
  const denied = restrictedBy?.(r.query) ?? []
  if (denied.length) return { status: 'restricted', issues: denied }
  return { status: 'ok', params: bookingQueryToParams(r.query) }
}
