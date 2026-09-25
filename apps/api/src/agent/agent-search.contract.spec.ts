import { AgentController } from './agent.controller'
import type { SupplierAdapter } from './supplier.port'
import type { AgentFinanceService } from './finance.service'
import type { AgentAuditService } from './audit.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import type { Request } from 'express'

const criteria = { destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED' }
const identity = { user: { id: 'user-a' } } as AuthenticatedUser
const hotel = {
  hotelId: 'h1', name: 'Hotel', destination: 'Dubai', starRating: 5, supplierId: 's1', supplierHotelId: 'sh1',
  rooms: [{ roomTypeId: 'r1', name: 'King', supplierRoomId: 'sr1', rates: [{
    offerId: 'o1', hotelId: 'h1', roomTypeId: 'r1', supplierId: 's1', supplierRoomId: 'sr1',
    tenantId: 'tenant-a', providerId: 'provider-a', canonicalHotelId: 'h1', canonicalRoomTypeId: 'r1',
    ratePlanId: 'p1', ratePlanName: 'Flexible', boardBasisId: 'b1', boardBasisName: 'Breakfast',
    supplierRateId: 'sp1', expiresAt: '2099-01-01T00:00:00Z',
    occupancy: { rooms: 1, adults: 2, children: 0, childAges: [] },
    cancellation: { refundable: true, summary: 'Free until deadline' }, availability: 'available', available: true,
    total: { amountMinor: 125099, currency: 'AED' }, netAmountMinor: 110000, taxAmountMinor: 10000,
    feeAmountMinor: 99, totalAmountMinor: 120099, markupAmountMinor: 5000, sellAmountMinor: 125099,
    paymentType: 'credit', source: 'bedbank',
  }] }],
}
function setup(search: jest.Mock, name = 'supplier-a') {
  const supplier = { name, search } as unknown as SupplierAdapter
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AgentAuditService
  const controller = new AgentController(supplier, {} as AgentFinanceService, audit)
  return { controller, audit }
}
const query = () => ({ ...criteria } as Parameters<AgentController['search']>[0])
const request = () => ({ requestId: 'request-a', activeTenantId: 'tenant-a' }) as unknown as Request
const supplierResult = (offers: unknown[], failed = 0) => ({ offers, providerSummary: { queried: 1, succeeded: failed ? 0 : 1, failed } })

describe('Agent canonical search boundary', () => {
  it('returns one validated nested offer without calculating its total', async () => {
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([hotel])))
    const result = await controller.search(query(), identity, request())
    expect(result.status).toBe('available')
    expect(result.version).toBe(1)
    expect(result.requestId).toBe('request-a')
    expect(result.searchId).toEqual(expect.any(String))
    expect(result.hotels[0].rooms[0].rates[0].total).toEqual({ amountMinor: 125099, currency: 'AED' })
  })
  it('returns partial only when a failed provider accompanies verified offers', async () => {
    const partial = supplierResult([hotel])
    partial.providerSummary = { queried: 2, succeeded: 1, failed: 1 }
    const { controller } = setup(jest.fn().mockResolvedValue(partial))
    expect((await controller.search(query(), identity, request())).status).toBe('partial')
  })
  it('enforces advertised filters and limit at the API boundary', async () => {
    const other = structuredClone(hotel)
    other.hotelId = 'h2'; other.rooms[0].rates[0].hotelId = 'h2'; other.rooms[0].rates[0].canonicalHotelId = 'h2'
    other.rooms[0].rates[0].offerId = 'o2'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([hotel, other])))
    const result = await controller.search({ ...query(), limit: 1, filters: { starRatings: [5], boardBasisIds: ['b1'], refundableOnly: true,
      minPriceMinor: 125000, maxPriceMinor: 126000 } }, identity, request())
    expect(result.status).toBe('available')
    expect(result.hotels).toHaveLength(1)
  })
  it('fails closed on a cross-tenant canonical offer', async () => {
    const invalid = structuredClone(hotel)
    invalid.rooms[0].rates[0].tenantId = 'tenant-b'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([invalid])))
    expect((await controller.search(query(), identity, request())).status).toBe('mapping_unavailable')
  })
  it('rejects a conflicting board, room or price as mapping unavailable', async () => {
    const invalid = structuredClone(hotel)
    invalid.rooms[0].rates[0].roomTypeId = 'other-room'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([invalid])))
    const result = await controller.search(query(), identity, request())
    expect(result.status).toBe('mapping_unavailable')
    expect(result.hotels).toEqual([])
  })
  it('distinguishes empty search from provider failure', async () => {
    const empty = setup(jest.fn().mockResolvedValue(supplierResult([])))
    expect((await empty.controller.search(query(), identity, request())).status).toBe('no_availability')
    const failed = setup(jest.fn().mockRejectedValue(Error('secret supplier URL')))
    const result = await failed.controller.search(query(), identity, request())
    expect(result.status).toBe('provider_unavailable')
    expect(JSON.stringify(result)).not.toContain('secret supplier URL')
  })
  it('never invokes recheck or prebook from disabled routes', async () => {
    const { controller } = setup(jest.fn())
    const action = { hotelId: 'h1', rateId: 'o1', idempotencyKey: 'key', totalMinor: 1, currency: 'AED' }
    expect((await controller.recheck(action, 'tenant-a', identity)).status).toBe('provider_unavailable')
    expect((await controller.prebook(action, 'tenant-a', identity)).status).toBe('booking_unavailable')
    expect((await controller.createBooking(action, 'tenant-a', identity)).status).toBe('booking_unavailable')
  })
})
