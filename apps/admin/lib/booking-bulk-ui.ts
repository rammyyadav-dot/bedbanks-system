// Pure helpers for bulk actions on the booking list (ADR 0039, Phase 6C). No React, no network.
// Selection is explicit booking ids only, capped at the same hard limit the server enforces; the server judges every booking again.
import { BOOKING_BULK_ACTIONS, BOOKING_BULK_ITEM_ERROR_LABEL, BOOKING_BULK_MAX_IDS, BOOKING_BULK_PERMISSION, BOOKING_BULK_UNDERLYING_PERMISSION, type BookingAccessView, type BookingBulkAction, type BookingBulkOperationView } from '@bedbanks/contracts'

/** Which bulk actions this person may start. Only hides controls: the API checks the capability and each booking's own permission again. */
export function bulkCapabilities(access: BookingAccessView | null): BookingBulkAction[] {
  if (!access || access.level !== 'OPERATOR' || !access.opsQueue) return []
  return BOOKING_BULK_ACTIONS.filter((a) => access.permissions.includes(BOOKING_BULK_PERMISSION[a]) && access.permissions.includes(BOOKING_BULK_UNDERLYING_PERMISSION[a]))
}

export type Selection = ReadonlySet<string>
export const EMPTY_SELECTION: Selection = new Set<string>()

export function toggleSelected(selection: Selection, id: string): Selection {
  const next = new Set(selection)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}
/** Selects every row of the current page, or clears them when they are all selected already. Selections from other pages are kept. */
export function togglePage(selection: Selection, pageIds: readonly string[]): Selection {
  const next = new Set(selection)
  if (pageIds.length > 0 && pageIds.every((id) => next.has(id))) pageIds.forEach((id) => next.delete(id)); else pageIds.forEach((id) => next.add(id))
  return next
}
export const pageSelectionState = (selection: Selection, pageIds: readonly string[]): 'none' | 'some' | 'all' => {
  const n = pageIds.filter((id) => selection.has(id)).length
  return n === 0 ? 'none' : n === pageIds.length ? 'all' : 'some'
}
/** The ids to send, in selection order. Null when over the limit: the UI refuses rather than truncating. */
export function selectionIds(selection: Selection): string[] | null {
  return selection.size > BOOKING_BULK_MAX_IDS ? null : [...selection]
}
export const selectionProblem = (selection: Selection): string | null =>
  selection.size === 0 ? 'Select at least one booking.' : selection.size > BOOKING_BULK_MAX_IDS ? `You can act on at most ${BOOKING_BULK_MAX_IDS} bookings at once. Clear some and try again; nothing was truncated.` : null

/** The headline of a finished operation. Partial success is never reported as plain success. */
export function resultHeadline(op: Pick<BookingBulkOperationView, 'status' | 'requestedCount' | 'succeededCount' | 'failedCount'>): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (op.status === 'SUCCEEDED') return { tone: 'ok', text: `All ${op.requestedCount} booking${op.requestedCount === 1 ? '' : 's'} updated.` }
  if (op.status === 'PARTIAL') return { tone: 'warn', text: `${op.succeededCount} of ${op.requestedCount} updated; ${op.failedCount} could not be.` }
  if (op.status === 'FAILED') return { tone: 'bad', text: `None of the ${op.requestedCount} booking${op.requestedCount === 1 ? '' : 's'} could be updated.` }
  return { tone: 'warn', text: `Still running: ${op.succeededCount + op.failedCount} of ${op.requestedCount} processed.` }
}
export const failureSummary = (op: Pick<BookingBulkOperationView, 'failuresByCode'>): Array<{ code: string; label: string; count: number }> =>
  Object.entries(op.failuresByCode).filter(([, n]) => (n ?? 0) > 0).map(([code, count]) => ({ code, label: BOOKING_BULK_ITEM_ERROR_LABEL[code as keyof typeof BOOKING_BULK_ITEM_ERROR_LABEL] ?? 'Could not be completed', count: count as number }))
/** Ids that failed, so the person can keep exactly those selected. */
export const failedIds = (op: Pick<BookingBulkOperationView, 'items'>): string[] => op.items.filter((i) => i.status === 'FAILED').map((i) => i.bookingId)
