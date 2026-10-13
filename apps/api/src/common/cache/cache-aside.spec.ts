import { CacheAside } from './cache-aside'
import type { CachePort } from './cache.port'

class MemoryCache implements CachePort {
  readonly store = new Map<string, unknown>()
  readonly ttls: number[] = []
  fail: { get?: boolean; set?: boolean } = {}
  async get<T>(key: string): Promise<T | null> {
    if (this.fail.get) throw new Error('down')
    return (this.store.get(key) as T) ?? null
  }
  async set<T>(key: string, value: T, options: { ttlMs: number }): Promise<void> {
    if (this.fail.set) throw new Error('down')
    this.ttls.push(options.ttlMs)
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> { this.store.delete(key) }
}

describe('CacheAside', () => {
  it('loads once, then serves hits without calling the loader', async () => {
    const cache = new MemoryCache()
    const reader = new CacheAside(cache)
    const load = jest.fn(async () => ({ boards: ['BB'] }))
    await expect(reader.read('k', 1_000, load)).resolves.toEqual({ boards: ['BB'] })
    await expect(reader.read('k', 1_000, load)).resolves.toEqual({ boards: ['BB'] })
    expect(load).toHaveBeenCalledTimes(1)
    expect(reader.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('coalesces concurrent misses into one load (stampede protection)', async () => {
    const reader = new CacheAside(new MemoryCache())
    let release!: (value: string) => void
    const load = jest.fn(() => new Promise<string>(resolve => { release = resolve }))
    const calls = Promise.all([reader.read('k', 1_000, load), reader.read('k', 1_000, load), reader.read('k', 1_000, load)])
    await new Promise(resolve => setImmediate(resolve))
    release('v')
    await expect(calls).resolves.toEqual(['v', 'v', 'v'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(reader.stats().coalesced).toBe(2)
  })

  it('falls through to the loader when the cache is down, and records the faults', async () => {
    const cache = new MemoryCache()
    cache.fail = { get: true, set: true }
    const reader = new CacheAside(cache)
    await expect(reader.read('k', 1_000, async () => 'authoritative')).resolves.toBe('authoritative')
    expect(reader.stats().cacheFaults).toBe(2)
  })

  it('does not swallow a loader failure and does not cache it', async () => {
    const cache = new MemoryCache()
    const reader = new CacheAside(cache)
    await expect(reader.read('k', 1_000, async () => { throw new Error('db down') })).rejects.toThrow('db down')
    expect(cache.store.size).toBe(0)
    await expect(reader.read('k', 1_000, async () => 'ok')).resolves.toBe('ok')
  })

  it('does not cache null so a missing record is seen the moment it exists', async () => {
    const cache = new MemoryCache()
    const reader = new CacheAside(cache)
    await expect(reader.read<string | null>('k', 1_000, async () => null)).resolves.toBeNull()
    expect(cache.store.size).toBe(0)
  })

  it('discards a cached value that fails shape validation and reloads it', async () => {
    const cache = new MemoryCache()
    cache.store.set('k', { legacy: true })
    const reader = new CacheAside(cache)
    const accept = (v: unknown): v is { boards: string[] } => Array.isArray((v as { boards?: unknown })?.boards)
    await expect(reader.read('k', 1_000, async () => ({ boards: ['HB'] }), { accept })).resolves.toEqual({ boards: ['HB'] })
    expect(cache.store.get('k')).toEqual({ boards: ['HB'] })
  })

  it('invalidate forces the next read to reload', async () => {
    const cache = new MemoryCache()
    const reader = new CacheAside(cache)
    let version = 1
    await reader.read('k', 1_000, async () => version)
    version = 2
    await reader.invalidate('k')
    await expect(reader.read('k', 1_000, async () => version)).resolves.toBe(2)
  })

  it('jitters TTL within bounds and rejects unbounded TTLs', async () => {
    const cache = new MemoryCache()
    const reader = new CacheAside(cache)
    for (let index = 0; index < 50; index += 1) await reader.read(`k${index}`, 10_000, async () => index, { jitterRatio: 0.1 })
    expect(Math.min(...cache.ttls)).toBeGreaterThanOrEqual(9_000)
    expect(Math.max(...cache.ttls)).toBeLessThanOrEqual(11_000)
    await expect(reader.read('x', 0, async () => 1)).rejects.toThrow('TTL')
  })
})
