import { ServiceUnavailableException } from '@nestjs/common'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'
import { SupplierProviderError } from './supplier.port'

const command: any = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a', idempotencyKey: 'booking-key-123',
  offerId: 'offer-a', searchId: 'search-a', inventoryHoldId: 'hold-a', canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a', ratePlanId: 'rate-a', boardBasisId: 'board-a',
  checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1, adults: 2, children: 0, childAges: [],
  currency: 'AED', totalMinor: 6000, leadGuest: { firstName: 'Test', lastName: 'Guest' }, walletId: 'wallet-a',
}
const booking = { id: 'booking-a', reference: 'FB-ABC', status: 'PENDING' }

function setup() {
  const bookings = { persistPending: jest.fn().mockResolvedValue(booking), recordSupplierPrebook: jest.fn().mockResolvedValue(undefined) }
  const finance = { authorize: jest.fn().mockResolvedValue({ id: 'hold-ledger' }), release: jest.fn().mockResolvedValue({ id: 'release-ledger' }) }
  const recovery = { compensate: jest.fn().mockResolvedValue({ status: 'compensated', financeReleased: true, inventoryReleased: true }) }
  const supplier = { prebook: jest.fn().mockResolvedValue({ supplierReference: 'supplier-prebook-a', rate: {} }) }
  const audit = { record: jest.fn().mockResolvedValue(undefined) }
  const holds = { beginProcessing: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined) }
  return { service: new SupplierPrebookOrchestrationService(bookings as any, finance as any, recovery as any, holds as any, audit as any, supplier as any), bookings, finance, recovery, supplier, holds, audit }
}

describe('SupplierPrebookOrchestrationService', () => {
  it('persists PENDING, authorizes finance, and prebooks without confirming the booking', async () => {
    const { service, finance, recovery, supplier } = setup()
    await expect(service.execute(command)).resolves.toEqual({
      status: 'prebooked', bookingId: 'booking-a', bookingReference: 'FB-ABC', supplierReference: 'supplier-prebook-a',
    })
    expect(finance.authorize).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'booking-a', amountMinor: 6000n }))
    expect(supplier.prebook).toHaveBeenCalledWith(
      { offerId: 'offer-a', searchId: 'search-a', idempotencyKey: 'booking:booking-a:prebook' },
      { tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a' },
    )
    expect(recovery.compensate).not.toHaveBeenCalled()
  })

  it('releases finance and inventory when supplier prebook fails', async () => {
    const { service, recovery, supplier } = setup()
    supplier.prebook.mockRejectedValue(new Error('provider down'))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook unavailable')
    expect(recovery.compensate).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'booking-a', inventoryHoldId: 'hold-a' }))
  })

  it('fails closed for reconciliation when either compensation fails', async () => {
    const { service, recovery, supplier } = setup()
    supplier.prebook.mockRejectedValue(new Error('provider down'))
    recovery.compensate.mockResolvedValue({ status: 'reconciliation_required', financeReleased: false, inventoryReleased: false })
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook failed and compensation requires reconciliation')
    expect(recovery.compensate).toHaveBeenCalledTimes(1)
  })

  it('does not call supplier when booking persistence or finance authorization fails', async () => {
    const first = setup()
    first.bookings.persistPending.mockRejectedValue(new Error('hold invalid'))
    await expect(first.service.execute(command)).rejects.toThrow('hold invalid')
    expect(first.supplier.prebook).not.toHaveBeenCalled()

    const second = setup()
    second.finance.authorize.mockRejectedValue(new Error('insufficient credit'))
    await expect(second.service.execute(command)).rejects.toThrow('insufficient credit')
    expect(second.supplier.prebook).not.toHaveBeenCalled()
  })

  it('uses a sanitized service-unavailable boundary rather than supplier error details', async () => {
    const { service, supplier } = setup()
    supplier.prebook.mockRejectedValue(new Error('secret supplier credential failure'))
    await expect(service.execute(command)).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(service.execute(command)).rejects.not.toThrow('secret supplier credential failure')
  })

  it('claims the hold before moving money and never calls finance or the supplier if the hold is gone', async () => {
    const { service, holds, finance, supplier } = setup()
    holds.beginProcessing.mockRejectedValue(new Error('Inventory hold is no longer active'))
    await expect(service.execute(command)).rejects.toThrow('Inventory hold is no longer active')
    expect(finance.authorize).not.toHaveBeenCalled()
    expect(supplier.prebook).not.toHaveBeenCalled()
    expect(holds.beginProcessing).toHaveBeenCalledWith('tenant-a', 'hold-a', 'request-a', 'user-a')
  })

  it('returns only the inventory when finance authorization fails after the claim', async () => {
    const { service, holds, finance, recovery } = setup()
    finance.authorize.mockRejectedValue(new Error('Insufficient wallet credit'))
    await expect(service.execute(command)).rejects.toThrow('Insufficient wallet credit')
    expect(holds.release).toHaveBeenCalledWith('tenant-a', 'hold-a', 'request-a:authorize-failed', { type: 'USER', userId: 'user-a' })
    expect(recovery.compensate).not.toHaveBeenCalled()
  })

  it('records a durable prebook-success marker the reconciliation sweep respects, and survives an audit failure', async () => {
    const { service, audit } = setup()
    await service.execute(command)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', userId: 'user-a', action: 'booking.prebook.succeeded', entityId: 'booking-a' }))
    audit.record.mockRejectedValue(new Error('audit down'))
    await expect(service.execute(command)).resolves.toMatchObject({ status: 'prebooked' })
  })

  it.each(['timeout', 'transport'] as const)('keeps the hold and finance reservation when supplier prebook is %s', async (code) => {
    const { service, recovery, holds, bookings, audit, supplier } = setup()
    supplier.prebook.mockRejectedValue(new SupplierProviderError(code))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook outcome is unknown')
    expect(recovery.compensate).not.toHaveBeenCalled()
    expect(holds.release).not.toHaveBeenCalled()
    expect(bookings.recordSupplierPrebook).toHaveBeenCalledWith('tenant-a', 'booking-a', { outcome: 'unknown', code })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.prebook.unknown', payload: expect.objectContaining({ code, inventoryHoldId: 'hold-a' }) }))
  })

  it('still compensates a definitive supplier rejection', async () => {
    const { service, recovery, supplier, audit } = setup()
    supplier.prebook.mockRejectedValue(new SupplierProviderError('malformed_response'))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook unavailable')
    expect(recovery.compensate).toHaveBeenCalledTimes(1)
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.prebook.unknown' }))
  })

  it('does not retry the supplier or release inventory when the same booking is already unknown', async () => {
    const { service, supplier, recovery, holds, bookings } = setup()
    bookings.persistPending.mockResolvedValue({ ...booking, searchSnapshot: { supplierPrebook: { outcome: 'unknown', code: 'timeout' } } })
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook outcome is unknown')
    expect(supplier.prebook).not.toHaveBeenCalled()
    expect(recovery.compensate).not.toHaveBeenCalled()
    expect(holds.release).not.toHaveBeenCalled()
  })

  it('replays a recorded supplier reference without a second supplier call', async () => {
    const { service, supplier, recovery, bookings } = setup()
    bookings.persistPending.mockResolvedValue({ ...booking, searchSnapshot: { supplierPrebook: { outcome: 'prebooked', supplierReference: 'supplier-prebook-a' } } })
    await expect(service.execute(command)).resolves.toMatchObject({ status: 'prebooked', supplierReference: 'supplier-prebook-a' })
    expect(supplier.prebook).not.toHaveBeenCalled()
    expect(recovery.compensate).not.toHaveBeenCalled()
  })

  it('does not compensate when supplier success cannot be persisted', async () => {
    const { service, recovery, holds, bookings, audit, supplier } = setup()
    bookings.recordSupplierPrebook.mockRejectedValue(new Error('database down'))
    audit.record.mockRejectedValue(new Error('audit down'))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook requires reconciliation')
    expect(supplier.prebook).toHaveBeenCalledTimes(1)
    expect(recovery.compensate).not.toHaveBeenCalled()
    expect(holds.release).not.toHaveBeenCalled()
  })
})
