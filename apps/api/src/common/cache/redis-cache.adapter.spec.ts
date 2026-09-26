import { RedisCacheAdapter } from './redis-cache.adapter'

const redisUrl = process.env.REDIS_URL
const describeRedis = redisUrl ? describe : describe.skip

describeRedis('RedisCacheAdapter integration', () => {
  const redis = new RedisCacheAdapter(redisUrl ?? 'redis://127.0.0.1:6379', 1_000)
  const key = (name: string) => `fbeds:test:redis-cache:${name}:${Date.now()}`

  it('writes JSON atomically with TTL and expires it', async () => {
    const cacheKey = key('ttl')
    await redis.set(cacheKey, { ok: true }, { ttlMs: 100 })
    await expect(redis.get(cacheKey)).resolves.toEqual({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 160))
    await expect(redis.get(cacheKey)).resolves.toBeNull()
  })

  it('allows only one lease owner and permits acquisition after release', async () => {
    const lockKey = key('lock')
    const first = await redis.acquire(lockKey, 1_000)
    expect(first).not.toBeNull()
    await expect(redis.acquire(lockKey, 1_000)).resolves.toBeNull()
    if (!first) throw new Error('Expected first lease')
    await redis.release(first)
    const second = await redis.acquire(lockKey, 1_000)
    expect(second).not.toBeNull()
    if (second) await redis.release(second)
  })

  it('does not let a stale/non-owner token release another owner lease', async () => {
    const lockKey = key('ownership')
    const owner = await redis.acquire(lockKey, 1_000)
    if (!owner) throw new Error('Expected owner lease')
    await redis.release({ key: owner.key, token: 'not-the-owner' })
    await expect(redis.acquire(lockKey, 1_000)).resolves.toBeNull()
    await redis.release(owner)
  })
})
