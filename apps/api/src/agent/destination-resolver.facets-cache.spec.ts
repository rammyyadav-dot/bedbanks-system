import { DestinationResolverService } from './destination-resolver.service'
import type { CachePort } from '../common/cache/cache.port'

class MemoryCache implements CachePort {
  readonly store = new Map<string, unknown>()
  down = false
  async get<T>(key: string): Promise<T | null> { if (this.down) throw new Error('down'); return (this.store.get(key) as T) ?? null }
  async set<T>(key: string, value: T): Promise<void> { if (this.down) throw new Error('down'); this.store.set(key, value) }
  async delete(key: string): Promise<void> { this.store.delete(key) }
}

function build(cache: CachePort) {
  const boardFindMany = jest.fn(async () => [{ id: 'b1', name: 'Bed & Breakfast' }])
  const hotelFindMany = jest.fn(async () => [{ propertyType: 'Resort' }, { propertyType: 'Hotel' }])
  const hotelProfileFindMany = jest.fn(async () => [{ brandName: 'JW Marriott' }])
  const prisma = { withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => run({ boardBasis: { findMany: boardFindMany }, hotel: { findMany: hotelFindMany }, hotelProfile: { findMany: hotelProfileFindMany } }) }
  return { service: new DestinationResolverService(prisma as never, cache), boardFindMany }
}

describe('DestinationResolverService.facets cache-aside', () => {
  it('reads the database once per tenant, then serves the cache', async () => {
    const { service, boardFindMany } = build(new MemoryCache())
    const first = await service.facets('t1')
    const second = await service.facets('t1')
    expect(second).toEqual(first)
    expect(first.propertyTypes).toEqual(['Hotel', 'Resort'])
    expect(first.brands).toEqual(['JW Marriott'])
    expect(boardFindMany).toHaveBeenCalledTimes(1)
  })

  it('never shares a cached entry across tenants', async () => {
    const cache = new MemoryCache()
    const { service, boardFindMany } = build(cache)
    await service.facets('t1')
    await service.facets('t2')
    expect(boardFindMany).toHaveBeenCalledTimes(2)
    expect([...cache.store.keys()].every((key) => key.includes(':t1:') || key.includes(':t2:'))).toBe(true)
  })

  it('falls through to the database when the cache is down', async () => {
    const cache = new MemoryCache()
    cache.down = true
    const { service } = build(cache)
    await expect(service.facets('t1')).resolves.toMatchObject({ boards: [{ id: 'b1' }] })
  })
})
