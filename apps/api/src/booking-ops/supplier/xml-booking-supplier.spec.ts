import { BookingSupplierCallError } from './booking-supplier.port'
import { XmlBookingSupplier, type XmlConnectorPort } from './xml-booking-supplier'

const CTX = { tenantId: 't1', requestId: 'req 1/ü' }
const REQ = { reference: 'FB-0123456789ABCDEF0123', supplierKey: 'xml-fixture', checkIn: '2030-07-01', checkOut: '2030-07-03', currency: 'AED', sellMinor: 100n, rooms: [] }
const inputs = { resolve: async () => ({ rateToken: 'tok', expectedNetMinor: 9000, rooms: [{ guests: [{ title: null, firstName: 'A', lastName: 'B', isLead: true, age: null }] }] }) }
const callError = (code: string, delivery: string, supplierCode: string | null = null) => Object.assign(new Error('x'), { name: 'SupplierCallError', code, delivery, supplierCode })
function adapter(connector: Partial<XmlConnectorPort>) {
  return new XmlBookingSupplier('xml-fixture', connector as XmlConnectorPort, { supplierId: 's1', connectorId: 'c1' }, inputs)
}

describe('XmlBookingSupplier translation rules', () => {
  it('passes a stable idempotency key and the server-derived scope, not caller input', async () => {
    const book = jest.fn().mockResolvedValue({ outcome: 'CONFIRMED', supplierRef: 'S1', hotelConfirmationNo: null })
    await adapter({ book }).book(CTX, REQ)
    await adapter({ book }).book(CTX, REQ)
    const [request, context] = book.mock.calls[0]
    expect(request.idempotencyKey).toBe('FB-0123456789ABCDEF0123-book')
    expect(book.mock.calls[1][0].idempotencyKey).toBe(request.idempotencyKey)
    expect(context).toMatchObject({ tenantId: 't1', supplierId: 's1', connectorId: 'c1' })
    expect(context.correlationId).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('a definite supplier refusal is REJECTED; the code carries no free text', async () => {
    const book = jest.fn().mockRejectedValue(callError('supplier_fault', 'answered', 'NO AVAIL!'))
    await expect(adapter({ book }).book(CTX, REQ)).resolves.toEqual({ outcome: 'REJECTED', code: 'SUPPLIER_NOAVAIL' })
  })
  it.each([
    ['timeout', 'maybe_sent', 'timeout'], ['transport', 'maybe_sent', 'transport'], ['provider_unavailable', 'maybe_sent', 'transport'], ['circuit_open', 'not_sent', 'transport'],
    ['authentication', 'answered', 'error'], ['quota_exhausted', 'answered', 'error'], ['malformed_response', 'maybe_sent', 'error'], ['disabled', 'not_sent', 'error'],
  ])('%s THROWS (never REJECTED) so the runner asks the supplier before concluding', async (code, delivery, kind) => {
    const book = jest.fn().mockRejectedValue(callError(code, delivery))
    await expect(adapter({ book }).book(CTX, REQ)).rejects.toMatchObject({ name: 'BookingSupplierCallError', kind, code: code.toUpperCase() })
  })
  it('an unclassified error throws, and unavailable booking inputs never reach the supplier', async () => {
    await expect(adapter({ book: jest.fn().mockRejectedValue(new Error('boom')) }).book(CTX, REQ)).rejects.toBeInstanceOf(BookingSupplierCallError)
    const book = jest.fn()
    const noInputs = new XmlBookingSupplier('k', { book } as unknown as XmlConnectorPort, { supplierId: 's', connectorId: 'c' }, { resolve: async () => { throw new Error('no guests') } })
    await expect(noInputs.book(CTX, REQ)).rejects.toMatchObject({ code: 'BOOK_INPUTS_UNAVAILABLE' })
    expect(book).not.toHaveBeenCalled()
  })
  it('status: a definite answer is returned; a failure or refusal throws (cannot conclude "not held")', async () => {
    await expect(adapter({ statusByReference: jest.fn().mockResolvedValue({ found: false }) }).statusByReference(CTX, { reference: REQ.reference, supplierKey: 'k' })).resolves.toEqual({ found: false })
    await expect(adapter({ statusByReference: jest.fn().mockRejectedValue(callError('supplier_fault', 'answered')) }).statusByReference(CTX, { reference: REQ.reference, supplierKey: 'k' })).rejects.toMatchObject({ code: 'STATUS_REFUSED' })
    await expect(adapter({ statusByReference: jest.fn().mockRejectedValue(callError('timeout', 'answered')) }).statusByReference(CTX, { reference: REQ.reference, supplierKey: 'k' })).rejects.toMatchObject({ kind: 'timeout' })
  })
  it('cancel maps CANCELLED and refusals', async () => {
    const cancel = jest.fn().mockResolvedValue({ outcome: 'CANCELLED', supplierCancellationRef: 'C1', penaltyMinor: 0 })
    await expect(adapter({ cancel }).cancel(CTX, { reference: REQ.reference, supplierKey: 'k', supplierRef: 'S1' })).resolves.toEqual({ outcome: 'CANCELLED', supplierCancellationRef: 'C1' })
    expect(cancel.mock.calls[0][0].idempotencyKey).toBe('FB-0123456789ABCDEF0123-cancel')
    await expect(adapter({ cancel: jest.fn().mockRejectedValue(callError('supplier_fault', 'answered', '12')) }).cancel(CTX, { reference: REQ.reference, supplierKey: 'k', supplierRef: null })).resolves.toEqual({ outcome: 'REJECTED', code: 'SUPPLIER_12' })
  })
})
