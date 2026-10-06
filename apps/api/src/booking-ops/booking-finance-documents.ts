import { parseFrozenRules, type BookingDocumentType, type EffectivePenalty, type StoredPenaltyQuote } from '@bedbanks/contracts'
import { formatMinor } from '../agent/booking-document.render'

/**
 * The frozen content of an Admin booking document (ADR 0039, Phase 5). Pure. Money is integer minor units as decimal strings; the amounts shown are the ones the
 * finance events record. A voucher carries the guest-facing facts and NEVER the net rate, markup, supplier name or supplier reference; the invoice shows the sell total only.
 */
export interface DocumentBooking {
  reference: string; currency: string; totalMinor: bigint; paymentMode: string | null; isRefundable: boolean | null; hotelConfirmationNo: string | null; agentRef: string | null
  checkIn: Date | null; checkOut: Date | null; nights: number | null; cancellationPolicy: unknown
  rooms: Array<{ roomName: string | null; boardCode: string | null; adults: number; children: number; childAges: number[] }>
  guests: Array<{ firstName: string; lastName: string; isLead: boolean }>
}
export interface DocumentContent { issuedFor: string; hotel: { name: string; city: string; countryCode: string } | null }

const PAYMENT_TEXT: Record<string, string> = { CREDIT: 'On the agency credit account', PREPAID: 'Prepaid', PAY_AT_HOTEL: 'Payable by the guest at the hotel' }
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

export function buildDocumentPayload(type: BookingDocumentType, input: { booking: DocumentBooking; content: DocumentContent; penalty: EffectivePenalty; quote: StoredPenaltyQuote | null; cancelledAt: Date | null }): Record<string, unknown> {
  const { booking: b, content } = input
  const lead = b.guests.find((g) => g.isLead) ?? b.guests[0] ?? null
  const first = b.rooms[0]
  const base: Record<string, unknown> = {
    bookingReference: b.reference, issuedFor: content.issuedFor, agentRef: b.agentRef, hotelConfirmationNo: b.hotelConfirmationNo, currency: b.currency,
    hotel: content.hotel,
    room: first?.roomName ? { name: first.roomName } : undefined,
    board: first?.boardCode ? { code: first.boardCode, name: first.boardCode } : undefined,
    stay: { checkIn: day(b.checkIn), checkOut: day(b.checkOut), nights: b.nights, rooms: b.rooms.length, adults: b.rooms.reduce((n, r) => n + r.adults, 0), children: b.rooms.reduce((n, r) => n + r.children, 0), childAges: b.rooms.flatMap((r) => r.childAges) },
    leadGuest: lead ? { firstName: lead.firstName, lastName: lead.lastName } : undefined,
  }
  const total = b.totalMinor.toString()
  const invoiceNumber = `INV-${b.reference}`
  if (type === 'VOUCHER') {
    const rules = parseFrozenRules(b.cancellationPolicy)
    return { ...base, guests: b.guests.map((g) => `${g.firstName} ${g.lastName}`), nonRefundable: b.isRefundable === false,
      cancellationPolicy: (rules ?? []).map((r) => ({ daysBeforeCheckin: r.daysBeforeCheckin, penalty: r.penaltyPercent !== undefined ? `${r.penaltyPercent}% of the booking total` : formatMinor(r.penaltyMinor as string, b.currency) })) }
  }
  if (type === 'INVOICE') {
    const description = `Accommodation${first?.roomName ? ` — ${first.roomName}` : ''}${first?.boardCode ? `, ${first.boardCode}` : ''}${b.nights ? `, ${b.nights} night${b.nights === 1 ? '' : 's'}` : ''}${b.rooms.length > 1 ? ` × ${b.rooms.length} rooms` : ''}`
    return { ...base, lines: [{ description, amountMinor: total }], totalMinor: total, payment: { text: b.paymentMode ? PAYMENT_TEXT[b.paymentMode] ?? 'Payment terms as agreed' : 'Payment terms as agreed' } }
  }
  const penalty = input.penalty.state === 'QUOTED' || input.penalty.state === 'DECIDED' || input.penalty.state === 'WAIVED' ? input.penalty : null
  if (!penalty) throw new Error('A cancellation document needs a determined penalty')
  const q = input.quote && input.quote.status === 'quotable' ? input.quote : null
  const common = { ...base, originalInvoiceNumber: invoiceNumber, totalMinor: total, penaltyMinor: penalty.penaltyMinor, refundMinor: penalty.refundMinor, cancelledAt: input.cancelledAt ? input.cancelledAt.toISOString() : null }
  if (type === 'CREDIT_NOTE') return { ...common, creditedTo: 'Credit against the invoice; settled by Finance' }
  return { ...common, penaltyState: penalty.state, basis: penalty.state === 'QUOTED' ? (q?.basis ?? null) : penalty.state,
    ruleDaysBeforeCheckin: q?.ruleDaysBeforeCheckin ?? null, quotedPenaltyMinor: q?.penaltyMinor ?? null }
}
