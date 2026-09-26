import { AgentSearchService } from './agent-search.service'
import type { SupplierAdapter } from './supplier.port'
import type { AgentAuditService } from './audit.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import type { CachePort, CacheWriteOptions, CoordinationPort, LockLease } from '../common/cache/cache.port'

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

class MemoryCache implements CachePort {
  readonly values = new Map<string, unknown>()
  readonly writes: Array<{ key: string; options: CacheWriteOptions }> = []
  failReads = false
  failWrites = false
  async get<T>(key: string): Promise<T | null> {
    if (this.failReads) throw new Error('redis unavailable')
    return (this.values.get(key) as T | undefined) ?? null
  }
  async set<T>(key: string, value: T, options: CacheWriteOptions): Promise<void> {
    if (this.failWrites) throw new Error('redis unavailable')
    this.values.set(key, value)
    this.writes.push({ key, options })
  }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

class MemoryCoordination implements CoordinationPort {
  private held = false
  async acquire(key: string, _ttlMs: number): Promise<LockLease | null> {
    if (this.held) return null
    this.held = true
    return { key, token: 'owner' }
  }
  async release(_lease: LockLease): Promise<void> { this.held = false }
}

const supplierResult = (offers: unknown[], failed = 0) => ({ offers, providerSummary: { queried: 1, succeeded: failed ? 0 : 1, failed } })
const setup = (search: jest.Mock, cache = new MemoryCache(), name = 'supplier-a', coordination?: CoordinationPort) => {
  const supplier = { name, search } as unknown as SupplierAdapter
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AgentAuditService
  return { service: new AgentSearchService(supplier, audit, cache, coordination), cache, audit }
}

describe('AgentSearchService cache boundary', () => {
  beforeEach(() => { delete process.env.AGENT_SEARCH_CACHE_TTL_MS })

  it('caches a verified search with a bounded TTL and reuses it', async () => {
    const search = jest.fn().mockResolvedValue(supplierResult([hotel]))
    const { service, cache } = setup(search)
    const first = await service.execute(criteria, 'tenant-a', 'request-a', identity)
    const second = await service.execute(criteria, 'tenant-a', 'request-b', identity)
    expect(first.status).toBe('available')
    expect(second.status).toBe('available')
    expect(search).toHaveBeenCalledTimes(1)
    expect(second.requestId).toBe('request-b')
    expect(second.searchId).not.toBe(first.searchId)
    expect(cache.writes[0].options.ttlMs).toBe(45_000)
    expect(cache.writes[0].key).toContain(':tenant-a:agent-search:')
  })

  it('isolates tenant cache entries', async () => {
    const search = jest.fn().mockResolvedValue(supplierResult([hotel]))
    const { service } = setup(search)
    await service.execute(criteria, 'tenant-a', 'request-a', identity)
    const tenantB = structuredClone(hotel)
    tenantB.rooms[0].rates[0].tenantId = 'tenant-b'
    search.mockResolvedValueOnce(supplierResult([tenantB]))
    await service.execute(criteria, 'tenant-b', 'request-b', identity)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('differentiates dates, occupancy, destination and currency', async () => {
    const search = jest.fn().mockResolvedValue(supplierResult([hotel]))
    const { service } = setup(search)
    await service.execute(criteria, 'tenant-a', 'r1', identity)
    await service.execute({ ...criteria, checkOut: '2026-10-05' }, 'tenant-a', 'r2', identity)
    await service.execute({ ...criteria, adults: 3 }, 'tenant-a', 'r3', identity)
    await service.execute({ ...criteria, destination: 'Abu Dhabi' }, 'tenant-a', 'r4', identity)
    await service.execute({ ...criteria, currency: 'USD' }, 'tenant-a', 'r5', identity)
    expect(search).toHaveBeenCalledTimes(5)
  })

  it('does not cache provider failures or mapping failures', async () => {
    const failedSearch = jest.fn().mockRejectedValue(new Error('secret endpoint'))
    const failed = setup(failedSearch)
    expect((await failed.service.execute(criteria, 'tenant-a', 'r1', identity)).status).toBe('provider_unavailable')
    expect(failed.cache.writes).toHaveLength(0)

    const invalid = structuredClone(hotel)
    invalid.rooms[0].rates[0].tenantId = 'tenant-b'
    const mapped = setup(jest.fn().mockResolvedValue(supplierResult([invalid])))
    expect((await mapped.service.execute(criteria, 'tenant-a', 'r2', identity)).status).toBe('mapping_unavailable')
    expect(mapped.cache.writes).toHaveLength(0)
  })

  it('caches genuine zero availability but not failed-provider zero results', async () => {
    const empty = setup(jest.fn().mockResolvedValue(supplierResult([])))
    expect((await empty.service.execute(criteria, 'tenant-a', 'r1', identity)).status).toBe('no_availability')
    expect(empty.cache.writes).toHaveLength(1)

    const providerFailed = setup(jest.fn().mockResolvedValue({ offers: [], providerSummary: { queried: 1, succeeded: 0, failed: 1 } }))
    expect((await providerFailed.service.execute(criteria, 'tenant-a', 'r2', identity)).status).toBe('provider_unavailable')
    expect(providerFailed.cache.writes).toHaveLength(0)
  })

  it('fails open when cache reads or writes are unavailable', async () => {
    const cache = new MemoryCache()
    cache.failReads = true
    cache.failWrites = true
    const search = jest.fn().mockResolvedValue(supplierResult([hotel]))
    const { service } = setup(search, cache)
    expect((await service.execute(criteria, 'tenant-a', 'r1', identity)).status).toBe('available')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent equivalent misses behind one lease owner', async () => {
    const search = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
      return supplierResult([hotel])
    })
    const { service } = setup(search, new MemoryCache(), 'supplier-a', new MemoryCoordination())
    const requests = Array.from({ length: 25 }, (_, index) =>
      service.execute(criteria, 'tenant-a', `concurrent-${index}`, identity))
    const results = await Promise.all(requests)
    expect(results).toHaveLength(25)
    expect(results.every(result => result.status === 'available')).toBe(true)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('clamps configured TTL to a short bounded window', async () => {
    process.env.AGENT_SEARCH_CACHE_TTL_MS = '999999'
    const { service, cache } = setup(jest.fn().mockResolvedValue(supplierResult([hotel])))
    await service.execute(criteria, 'tenant-a', 'r1', identity)
    expect(cache.writes[0].options.ttlMs).toBe(120_000)
  })
})
