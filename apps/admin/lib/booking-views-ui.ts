// Pure helpers for saved booking views (ADR 0039, Phase 6B). No React, no network. Opening a view resolves into the normal booking-query URL and nothing else:
// the list is still fetched through the one canonical query, which the server validates again for the person who is looking.
import { bookingQueryKey, bookingQueryToParams, defaultSortFor, normalizeBookingQuery, type BookingListQuery, type BookingSavedViewView, type SavedViewWriteRequest } from '@bedbanks/contracts'
import { bookingQueryString } from './booking-ui'

/** The URL parameter that names the active view. UI-only: it is never sent to the API (the list reads only the filter keys). */
export const VIEW_PARAM = 'view'

const NOT_FILTERS = new Set(['page', 'pageSize', 'sort', 'dir'])

/** The canonical parameters of a list query, without paging. */
function paramsOf(query: BookingListQuery): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(bookingQueryString({ ...query, page: undefined, pageSize: undefined }).replace(/^\?/, '')))
}

/** What "save the current view" sends: filters without sort or paging, and the sort apart. The server normalizes again. */
export function currentViewPayload(query: BookingListQuery, columns: readonly string[] | null): Pick<SavedViewWriteRequest, 'filters' | 'sort' | 'visibleColumns'> {
  const params = paramsOf(query)
  const base = defaultSortFor((params.chip as BookingListQuery['chip']) ?? null)
  const filters = Object.fromEntries(Object.entries(params).filter(([k]) => !NOT_FILTERS.has(k)))
  return { filters, sort: { sort: params.sort ?? base.sort, dir: params.dir ?? base.dir }, visibleColumns: columns ? [...columns] : null }
}

/** The URL that opens a view, or null when the server says it cannot be applied (stale grammar, or a filter this person may no longer use). */
export function viewHref(view: BookingSavedViewView): string | null {
  if (view.resolution.status !== 'ok') return null
  const qs = new URLSearchParams({ ...view.resolution.params, [VIEW_PARAM]: view.id }).toString()
  return `/bookings?${qs}`
}

/** True when the current filters, sort and direction differ from what the view opens to. Anything that does not normalize counts as different. */
export function isModified(query: BookingListQuery, view: BookingSavedViewView): boolean {
  if (view.resolution.status !== 'ok') return true
  const current = normalizeBookingQuery(paramsOf(query))
  const saved = normalizeBookingQuery(view.resolution.params)
  if (!current.ok || !saved.ok) return true
  return bookingQueryKey(current.query) !== bookingQueryKey(saved.query)
}

export const viewProblem = (view: BookingSavedViewView): string | null =>
  view.resolution.status === 'ok' ? null
    : view.resolution.status === 'restricted' ? 'This view uses a filter you no longer have access to, so it is not applied.'
      : 'This view uses filters the system no longer understands, so it is not applied. Rename or delete it, or save the current filters as a new view.'

/** Appends the active view to an href so the list keeps knowing which view it is showing. */
export function withView(href: string, viewId: string | null): string {
  if (!viewId) return href
  return `${href}${href.includes('?') ? '&' : '?'}${VIEW_PARAM}=${encodeURIComponent(viewId)}`
}

export { bookingQueryToParams }
