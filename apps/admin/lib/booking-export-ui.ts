// Pure helpers for exporting and printing the booking list (ADR 0039, Phase 6D). No React, no network.
// They only decide what to show and what to send; the API checks the permission, the scope and the row limit again and audits every export.
import { BOOKING_EXPORT_MAX_ROWS, bookingExportPermission, type BookingAccessView, type BookingListQuery } from '@bedbanks/contracts'
import { bookingQueryString } from './booking-ui'

/** Shows the Export control. Hiding it is a courtesy: the API refuses a caller without the formal permission. */
export const canExport = (access: BookingAccessView | null): boolean => access !== null && access.permissions.includes(bookingExportPermission(access))

/** The query an export sends: the list's filters, never its page or page size (the file is the whole answer, up to the limit), and without the reconciliation-flag filter, which cannot be exported. */
export function exportParams(query: BookingListQuery): Record<string, string> {
  const { page: _page, pageSize: _pageSize, attention: _attention, ...rest } = query
  return Object.fromEntries(new URLSearchParams(bookingQueryString(rest as BookingListQuery).replace(/^\?/, '')))
}

/** An export is refused above the limit, so the screen can say so before the person clicks. */
export const exportTooLarge = (total: number | null): boolean => total !== null && total > BOOKING_EXPORT_MAX_ROWS

export function exportBlockedReason(query: BookingListQuery, total: number | null): string | null {
  if (query.attention) return 'The reconciliation-flag filter cannot be exported. Remove it to export.'
  if (exportTooLarge(total)) return `${total!.toLocaleString('en-GB')} bookings match; an export carries at most ${BOOKING_EXPORT_MAX_ROWS.toLocaleString('en-GB')}. Narrow the filters (dates, agency, status) first.`
  return null
}

export function exportDoneNote(rowCount: string | null, requestId: string | null): string {
  return `Exported ${rowCount ?? 'the'} booking${rowCount === '1' ? '' : 's'} to CSV. The download was recorded in the audit log.${requestId ? ` Request ${requestId}.` : ''}`
}
