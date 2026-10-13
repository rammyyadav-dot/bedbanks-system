import type { HotelReportQuery, HotelReportView, HotelReportCurrency } from '@bedbanks/contracts'

export interface ReportBooking {
  status: string; currency: string; totalMinor: bigint; netMinor: bigint | null
  checkIn: Date | null; checkOut: Date | null; rooms: Array<{ quantity: number }>
  _count: { guests: number }; financeEvents: Array<{ type: string; currency: string; refundMinor: bigint | null; penaltyMinor: bigint | null }>
}
const REVENUE_STATUSES = new Set(['CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'COMPLETED', 'NO_SHOW'])
/** Pure reporting over saved booking evidence. No current hotel/rate-plan values enter this calculation. */
export function buildHotelReport(hotelId: string, query: HotelReportQuery, bookings: ReportBooking[], canNet: boolean, canFinance: boolean, now: Date): HotelReportView {
  const groups = new Map<string, HotelReportCurrency>()
  let roomNights = 0; let unknownRoomNightReservations = 0; let cancelledReservations = 0; let guests = 0
  for (const b of bookings) {
    guests += b._count.guests
    const g = groups.get(b.currency) ?? { currency: b.currency, reportingCurrency: b.currency, conversionBasis: 'IDENTITY', bookings: 0, grossMinor: '0', netMinor: canNet ? '0' : null, marginMinor: canNet ? '0' : null, cancelledGrossMinor: '0', refundMinor: canFinance ? '0' : null, penaltyMinor: canFinance ? '0' : null, taxesMinor: null }
    g.bookings++
    if (REVENUE_STATUSES.has(b.status)) {
      g.grossMinor = (BigInt(g.grossMinor) + b.totalMinor).toString()
      if (canNet) {
        g.netMinor = g.netMinor === null || b.netMinor === null ? null : (BigInt(g.netMinor) + b.netMinor).toString()
        g.marginMinor = g.netMinor === null ? null : (BigInt(g.grossMinor) - BigInt(g.netMinor)).toString()
      }
      if (!b.checkIn || !b.checkOut || b.rooms.length === 0) unknownRoomNightReservations++
      else {
        const start = query.dateBasis === 'stay' ? Math.max(b.checkIn.getTime(), new Date(query.from).getTime()) : b.checkIn.getTime()
        const end = query.dateBasis === 'stay' ? Math.min(b.checkOut.getTime(), new Date(query.to).getTime() + 86400000) : b.checkOut.getTime()
        roomNights += Math.max(0, Math.round((end - start) / 86400000)) * b.rooms.reduce((sum, room) => sum + room.quantity, 0)
      }
    }
    if (b.status === 'CANCELLED') {
      cancelledReservations++; g.cancelledGrossMinor = (BigInt(g.cancelledGrossMinor) + b.totalMinor).toString()
      if (canFinance) {
        // The last cancellation evidence supersedes earlier quotes. A quote is never a cash refund.
        const event = b.financeEvents.filter(e => e.type === 'CANCELLED').at(-1)
        g.refundMinor = g.refundMinor === null || !event || event.currency !== b.currency || event.refundMinor === null ? null : (BigInt(g.refundMinor) + event.refundMinor).toString()
        g.penaltyMinor = g.penaltyMinor === null || !event || event.currency !== b.currency || event.penaltyMinor === null ? null : (BigInt(g.penaltyMinor) + event.penaltyMinor).toString()
      }
    }
    groups.set(b.currency, g)
  }
  return {
    hotelId, generatedAt: now.toISOString(), query, totalReservations: bookings.length, roomNights, unknownRoomNightReservations, cancelledReservations,
    currencies: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)), nationality: [{ nationality: 'Unknown', guests }],
    definitions: {
      scope: 'All reservations for this hotel and caller agency scope matching the date and supplier filters.',
      dates: query.dateBasis === 'booking' ? 'Booking creation date, inclusive UTC days; room nights cover the whole booked stay.' : 'Stays overlapping the inclusive hotel-local date range; room nights count only nights inside the range. Money is the full booking value of this cohort, not nightly allocated revenue.',
      roomNights: 'Booked room quantity × nights for CONFIRMED, AMEND_REQUESTED, CANCEL_REQUESTED, COMPLETED and NO_SHOW reservations. This measures contracted nights, not actual occupancy. Missing dates or room rows are counted separately.',
      gross: 'Saved sell amount for those same five statuses, before cancellation deductions. Pending, failed and cancelled reservations are excluded.',
      net: 'Saved supplier cost for the gross cohort; unavailable if any cost is missing or booking.view.net is absent. Margin = gross − net; it is not accounting profit.',
      cancellations: 'Original sell amount of CANCELLED reservations, shown separately and excluded from gross.',
      refunds: 'Refund entitlement and penalty from the last CANCELLED finance event, not proof of cash settlement. Unavailable if evidence is missing or booking.finance.view is absent.',
      currency: 'Original and reporting currency are identical (conversion rate 1). Different currencies are never summed. Frozen FX rates lack a target currency contract, so no cross-currency conversion is performed.',
      nationality: 'Guest nationality is not stored on BookingGuest. Every recorded guest is counted as Unknown; no nationality is inferred from agency or hotel location.',
      taxes: 'Tax components are not stored separately on bookings and are unavailable.',
    },
    limitations: ['Cross-currency reporting and tax breakdown require additional persisted data.', 'Guest nationality requires a recorded booking guest nationality field.', 'Revenue is booking cohort value, not recognized accounting revenue.'],
  }
}

const cell = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"'
export function hotelReportCsv(report: HotelReportView): string {
  const rows: unknown[][] = [['Hotel ID', report.hotelId], ['From', report.query.from], ['To', report.query.to], ['Date basis', report.query.dateBasis], ['Supplier', report.query.supplier ?? 'All'], ['Room nights', report.roomNights], ['Unknown room-night reservations', report.unknownRoomNightReservations], ['Reservations', report.totalReservations], ['Cancelled reservations', report.cancelledReservations], [], ['Original currency', 'Reporting currency', 'Conversion basis', 'Gross minor', 'Net minor', 'Margin minor', 'Cancelled gross minor', 'Refund entitlement minor', 'Penalty minor', 'Taxes minor']]
  for (const g of report.currencies) rows.push([g.currency, g.reportingCurrency, '1 (identity)', g.grossMinor, g.netMinor ?? 'Unavailable', g.marginMinor ?? 'Unavailable', g.cancelledGrossMinor, g.refundMinor ?? 'Unavailable', g.penaltyMinor ?? 'Unavailable', 'Unavailable'])
  rows.push([], ['Nationality', 'Guests'], ...report.nationality.map(n => [n.nationality, n.guests]), [], ['Metric', 'Definition'], ...Object.entries(report.definitions))
  // Defend spreadsheet formula execution in free-text filters and identifiers.
  return '\uFEFF' + rows.map(row => row.map(v => cell(typeof v === 'string' && /^[=+@\-\t\r]/.test(v) ? "'" + v : v)).join(',')).join('\r\n') + '\r\n'
}
