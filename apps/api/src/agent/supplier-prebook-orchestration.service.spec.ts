import { ServiceUnavailableException } from '@nestjs/common'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'

const command: any = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a', idempotencyKey: 'booking-key-123',
  offerId: 'offer-a', searchId: 'search-a', inventoryHoldId: 'hold-a', canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a', ratePlanId: 'rate-a', boardBasisId: 'board-a',
  checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1, adults: 2, children: 0, childAges: [],
  currency: 'AED', totalMinor: 6000, leadGuest: { firstName: 'Test', lastName: 'Guest' }, walletId: 'wallet-a',
}
const booking = { id: 'booking-a', reference: 'FB-ABC', status: 'PENDING' }

function setup() {
  const bookings = { persistPending: jest.fn().mockResolvedValue(booking) }
  const finance = { authorize: jest.fn().mockResolvedValue({ id: 'hold-ledger' }), release: jest.fn().mockResolvedValue({ id: 'release-ledger' }) }
  const inventory = { release: jest.fn().mockResolvedValue(undefined) }
  const supplier = { prebook: jest.fn().mockResolvedValue({ supplierReference: 'supplier-prebook-a', rate: {} }) }
  return { service: new SupplierPrebookOrchestrationService(bookings as any, finance as any, inventory as any, supplier as any), bookings, finance, inventory, supplier }
}

describe('SupplierPrebookOrchestrationService', () => {
  it('persists PENDING, authorizes finance, and prebooks without confirming the booking', async () => {
    const { service, finance, inventory, supplier } = setup()
    await expect(service.execute(command)).resolves.toEqual({
      status: 'prebooked', bookingId: 'booking-a', bookingReference: 'FB-ABC', supplierReference: 'supplier-prebook-a',
    })
    expect(finance.authorize).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'booking-a', amountMinor: 6000n }))
    expect(supplier.prebook).toHaveBeenCalledWith(
      { offerId: 'offer-a', searchId: 'search-a', idempotencyKey: 'booking:booking-a:prebook' },
      { tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a' },
    )
    expect(finance.release).not.toHaveBeenCalled()
    expect(inventory.release).not.toHaveBeenCalled()
  })

  it('releases finance and inventory when supplier prebook fails', async () => {
    const { service, finance, inventory, supplier } = setup()
    supplier.prebook.mockRejectedValue(new Error('provider down'))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook unavailable')
    expect(finance.release).toHaveBeenCalledTimes(1)
    expect(inventory.release).toHaveBeenCalledWith('tenant-a', 'hold-a', 'request-a:prebook-failed', { type: 'USER', userId: 'user-a' })
  })

  it('fails closed for reconciliation when either compensation fails', async () => {
    const { service, finance, inventory, supplier } = setup()
    supplier.prebook.mockRejectedValue(new Error('provider down'))
    finance.release.mockRejectedValue(new Error('ledger unavailable'))
    inventory.release.mockRejectedValue(new Error('inventory unavailable'))
    await expect(service.execute(command)).rejects.toThrow('Supplier prebook failed and compensation requires reconciliation')
    expect(finance.release).toHaveBeenCalledTimes(1)
    expect(inventory.release).toHaveBeenCalledTimes(1)
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
})
