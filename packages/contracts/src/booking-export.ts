/**
 * Booking export (ADR 0039, Phase 6D): `GET /admin/operations/bookings/export`. Pure and transport-agnostic: no Nest, no Prisma, no clock.
 *
 * The export is the Bookings list as a file. It selects with the same `BookingQueryV1` grammar as the list, so a person never gets rows the list would not
 * show them, and it exposes no column the list does not: the net rate and margin need `booking.view.net`, guest names are masked without
 * `booking.pii.view` (the rows already arrive masked from the server; this builder never un-masks anything).
 *
 * Two rules that matter for a spreadsheet:
 *  - Money is integer minor units rendered to a decimal string with integer arithmetic. No floating point. A currency whose exponent is not known is shown as
 *    its minor units with a suffix, never guessed.
 *  - A cell that a spreadsheet would run as a formula (starts with `=`, `+`, `-`, `@` or a tab, even after leading spaces or line breaks) is prefixed with an apostrophe, so a guest name or
 *    a supplier reference typed as `=HYPERLINK(...)` is shown, not executed.
 */
import type { BookingAccessView, BookingListRow } from './booking-ops'

/** Rows one synchronous export may carry. Above it the caller is told to narrow the query: an asynchronous export is not built. */
export const BOOKING_EXPORT_MAX_ROWS = 1000
export const BOOKING_EXPORT_FAILURE = { forbidden: 'BOOKING_EXPORT_FORBIDDEN', tooLarge: 'BOOKING_EXPORT_TOO_LARGE' } as const
export const BOOKING_EXPORT_FILENAME_PREFIX = 'bookings'

/** ISO-4217 minor-unit exponents of the currencies this platform sells in (kept in step with `@bedbanks/money`; contracts has no dependencies). */
const EXPONENTS: Readonly<Record<string, number>> = { AED: 2, AUD: 2, BHD: 3, CAD: 2, EUR: 2, GBP: 2, INR: 2, JPY: 0, KWD: 3, OMR: 3, QAR: 2, SAR: 2, SGD: 2, USD: 2 }

/** `12345` + `AED` -> `123.45`. Integer arithmetic only. An unknown currency (or a value that is not an integer) is shown as minor units with a suffix. */
export function formatMinorDecimal(minor: string, currency: string): string {
  if (!/^-?\d{1,18}$/.test(minor)) return `${minor} (minor units)`
  const exponent = EXPONENTS[currency]
  if (exponent === undefined) return `${minor} (minor units)`
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent)
  const fraction = digits.slice(digits.length - exponent)
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`
}

/** Neutralises a spreadsheet formula and quotes the cell for CSV (RFC 4180). */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value).replace(/\r\n|\r|\n/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  if (/^\s*[=+\-@]|^\t/.test(text)) text = `'${text}`
  return /[",;]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

export interface BookingExportColumn { id: string; header: string; value: (row: BookingListRow) => string | number | boolean | null }
const dayOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
const instant = (iso: string | null) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : null)

/** Columns every exporter gets. */
export const BOOKING_EXPORT_BASE_COLUMNS: readonly BookingExportColumn[] = [
  { id: 'reference', header: 'Booking #', value: (r) => r.reference },
  { id: 'status', header: 'Status', value: (r) => r.status },
  { id: 'supplierStatus', header: 'Supplier status', value: (r) => r.supplierStatus },
  { id: 'agency', header: 'Agency', value: (r) => r.agency?.name ?? null },
  { id: 'agent', header: 'Agent', value: (r) => r.agent },
  { id: 'agentRef', header: 'Agent ref', value: (r) => r.agentRef },
  { id: 'supplier', header: 'Supplier', value: (r) => r.supplier },
  { id: 'supplierRef', header: 'Supplier ref', value: (r) => r.supplierRef },
  { id: 'hotelConfirmationNo', header: 'Hotel confirmation no.', value: (r) => r.hotelConfirmationNo },
  { id: 'leadGuest', header: 'Lead guest', value: (r) => r.leadGuest?.name ?? null },
  { id: 'adults', header: 'Adults', value: (r) => r.guests?.adults ?? null },
  { id: 'children', header: 'Children', value: (r) => r.guests?.children ?? null },
  { id: 'hotel', header: 'Hotel', value: (r) => r.hotel.name },
  { id: 'city', header: 'City', value: (r) => r.hotel.city },
  { id: 'room', header: 'Room type', value: (r) => r.room?.name ?? null },
  { id: 'board', header: 'Board basis', value: (r) => r.room?.board ?? null },
  { id: 'checkIn', header: 'Check-in', value: (r) => r.checkIn },
  { id: 'checkOut', header: 'Check-out', value: (r) => r.checkOut },
  { id: 'nights', header: 'Nights', value: (r) => r.nights },
  { id: 'bookedOn', header: 'Booked on (UTC)', value: (r) => instant(r.createdAt) },
  { id: 'cancelDeadline', header: 'Free-cancellation deadline (UTC)', value: (r) => instant(r.cancelDeadline) },
  { id: 'refundable', header: 'Refundable', value: (r) => (r.isRefundable === null ? null : r.isRefundable ? 'Yes' : 'No') },
  { id: 'paymentMode', header: 'Payment mode', value: (r) => r.paymentMode },
  { id: 'paymentStatus', header: 'Payment status', value: (r) => r.paymentStatus },
  { id: 'currency', header: 'Currency', value: (r) => r.currency },
  { id: 'sell', header: 'Sell', value: (r) => formatMinorDecimal(r.sellMinor, r.currency) },
  { id: 'channel', header: 'Channel', value: (r) => r.channel },
  { id: 'assignedTo', header: 'Assigned to', value: (r) => r.assignedTo?.name ?? null },
  { id: 'amended', header: 'Amended', value: (r) => (r.amended ? 'Yes' : 'No') },
  { id: 'missingSupplierRef', header: 'Missing supplier ref', value: (r) => (r.missingSupplierRef ? 'Yes' : 'No') },
  { id: 'closedOn', header: 'Closed on', value: (r) => dayOnly(r.closedAt) },
]
/** Only with `booking.view.net`. */
export const BOOKING_EXPORT_NET_COLUMNS: readonly BookingExportColumn[] = [
  { id: 'net', header: 'Net', value: (r) => (r.netMinor === null ? null : formatMinorDecimal(r.netMinor, r.currency)) },
  { id: 'margin', header: 'Margin', value: (r) => (r.marginMinor === null ? null : formatMinorDecimal(r.marginMinor, r.currency)) },
]

/** The columns this caller may export. Net and margin are added only with `booking.view.net`; nothing here widens what the list shows. */
export function bookingExportColumns(access: Pick<BookingAccessView, 'canViewNet'>): readonly BookingExportColumn[] {
  return access.canViewNet ? [...BOOKING_EXPORT_BASE_COLUMNS, ...BOOKING_EXPORT_NET_COLUMNS] : BOOKING_EXPORT_BASE_COLUMNS
}

/** Which export permission applies: operators need `booking.export`, agency users `booking.export.agency`. */
export const bookingExportPermission = (access: Pick<BookingAccessView, 'level'>) => (access.level === 'OPERATOR' ? 'booking.export' : 'booking.export.agency') as 'booking.export' | 'booking.export.agency'

/** A UTF-8 CSV (with a byte-order mark so Excel reads accents), CRLF line ends, header first. */
export function bookingExportCsv(rows: readonly BookingListRow[], access: Pick<BookingAccessView, 'canViewNet'>): string {
  const columns = bookingExportColumns(access)
  const lines = [columns.map((c) => csvCell(c.header)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}

export const bookingExportFilename = (now: Date) => `${BOOKING_EXPORT_FILENAME_PREFIX}-${now.toISOString().slice(0, 10)}.csv`
