import { agentDocumentBlock } from './booking-document.service'

const confirmed = { type: 'INVOICE' as const, status: 'CONFIRMED', hotelConfirmationNo: 'HC-1', sellMinor: 100_000n, issued: [] as string[], cancellation: null }

describe('agent document eligibility', () => {
  it('uses the shared rule: an invoice follows confirmation, a credit note needs a cancelled booking, a decided refund and the invoice', () => {
    expect(agentDocumentBlock(confirmed)).toBeNull()
    expect(agentDocumentBlock({ ...confirmed, type: 'INVOICE', status: 'CHECKED_OUT' })).toBeNull()
    expect(agentDocumentBlock({ ...confirmed, type: 'INVOICE', status: 'PENDING_SUPPLIER' })).toBe('NOT_CONFIRMED')
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE' })).toBe('NOT_CANCELLED')
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE', status: 'CANCELLED', cancellation: { refundMinor: 40_000n } })).toBe('INVOICE_REQUIRED')
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE', status: 'CANCELLED', cancellation: { refundMinor: 40_000n }, issued: ['INVOICE'] })).toBeNull()
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE', status: 'CANCELLED', cancellation: { refundMinor: 0n }, issued: ['INVOICE'] })).toBe('NOTHING_TO_CREDIT')
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE', status: 'NO_SHOW', cancellation: { refundMinor: null }, issued: ['INVOICE'] })).toBe('PENALTY_DECISION_REQUIRED')
    expect(agentDocumentBlock({ ...confirmed, type: 'CREDIT_NOTE', status: 'CANCELLED', cancellation: { refundMinor: 100_001n }, issued: ['INVOICE'] })).toBe('PENALTY_DECISION_REQUIRED')
  })

  it('does not replace a voucher already on file, and still refuses a new one after cancellation', () => {
    expect(agentDocumentBlock({ ...confirmed, type: 'VOUCHER', status: 'CANCELLED', issued: ['VOUCHER'] })).toBe('ALREADY_ISSUED')
    expect(agentDocumentBlock({ ...confirmed, type: 'VOUCHER', status: 'CANCELLED' })).toBe('BOOKING_CANCELLED')
    expect(agentDocumentBlock({ ...confirmed, type: 'VOUCHER', hotelConfirmationNo: '  ' })).toBe('HOTEL_CONFIRMATION_REQUIRED')
  })
})
