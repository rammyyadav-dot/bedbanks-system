import { NoopCache, tenantCacheKey } from './cache.port'

describe('cache safety boundary', () => {
  it('builds tenant and version scoped keys', () => {
    expect(tenantCacheKey('tenant-a', 'hotel-content', 'hotel-a')).toBe('fbeds:v1:tenant-a:hotel-content:hotel-a')
  })
  it('rejects ambiguous key components and invalid TTLs', async () => {
    expect(() => tenantCacheKey('tenant:a', 'hotel', 'a')).toThrow('Invalid cache key component')
    await expect(new NoopCache().set('key', {}, { ttlMs: 0 })).rejects.toThrow('bounded positive')
  })
  it('fails open only as a cache miss and never invents data', async () => {
    expect(await new NoopCache().get('missing')).toBeNull()
  })
})
