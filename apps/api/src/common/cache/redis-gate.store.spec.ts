import { SharedConnectorGate, InProcessGate, type SharedGateLimits } from '@bedbanks/connectors-core'
import { RedisCacheAdapter } from './redis-cache.adapter'
import { RedisGateStore, type RedisScriptRunner } from './redis-gate.store'

const limits = (over: Partial<SharedGateLimits> = {}): SharedGateLimits => ({ maxConcurrent: 2, failureThreshold: 3, openMs: 200, slotTtlMs: 5_000, ...over })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('RedisGateStore reply handling', () => {
  const runner = (reply: string | number | null): RedisScriptRunner => ({ eval: async () => reply })

  it('maps script replies to gate results and passes the slot id through', async () => {
    await expect(new RedisGateStore(runner('acquired'), () => 'slot-x').acquire('g', limits())).resolves.toEqual({ status: 'acquired', slotId: 'slot-x' })
    await expect(new RedisGateStore(runner('busy')).acquire('g', limits())).resolves.toEqual({ status: 'busy' })
    await expect(new RedisGateStore(runner('open:1500')).acquire('g', limits())).resolves.toEqual({ status: 'open', retryAfterMs: 1500 })
  })

  it('treats any other reply as a store fault, so the gate applies its outage policy', async () => {
    for (const reply of ['open:', 'open:-1', 'OK', 1, null]) {
      await expect(new RedisGateStore(runner(reply)).acquire('g', limits())).rejects.toThrow('Unexpected gate acquire reply')
    }
    await expect(new RedisGateStore(runner('OK')).release('g', 's', 'ok', limits())).rejects.toThrow('Unexpected gate release reply')
  })

  it('uses hash-tagged keys so both keys share one cluster slot', async () => {
    const seen: string[][] = []
    await new RedisGateStore({ eval: async (_script, keys) => { seen.push(keys); return 'busy' } }).acquire('fbeds:v1:gate:t:c', limits())
    expect(seen).toEqual([['{fbeds:v1:gate:t:c}:slots', '{fbeds:v1:gate:t:c}:state']])
  })
})

const redisUrl = process.env.REDIS_URL
const describeRedis = redisUrl ? describe : describe.skip

describeRedis('RedisGateStore against Redis (two adapters = two API tasks)', () => {
  const taskA = new RedisCacheAdapter(redisUrl ?? 'redis://127.0.0.1:6379', 1_000)
  const taskB = new RedisCacheAdapter(redisUrl ?? 'redis://127.0.0.1:6379', 1_000)
  const storeA = new RedisGateStore(taskA)
  const storeB = new RedisGateStore(taskB)
  afterAll(() => { taskA.close(); taskB.close() })
  let n = 0
  const gateKey = () => `fbeds:test:gate:${process.pid}-${Date.now()}-${n++}`
  const acquired = async (store: RedisGateStore, key: string, l: SharedGateLimits) => {
    const result = await store.acquire(key, l)
    if (result.status !== 'acquired') throw new Error(`expected a slot, got ${result.status}`)
    return result.slotId
  }

  it('enforces one concurrency limit across tasks and frees a slot on release', async () => {
    const key = gateKey()
    const first = await acquired(storeA, key, limits())
    await acquired(storeB, key, limits())
    await expect(storeA.acquire(key, limits())).resolves.toEqual({ status: 'busy' })
    await storeA.release(key, first, 'ok', limits())
    await expect(storeB.acquire(key, limits())).resolves.toMatchObject({ status: 'acquired' })
  })

  it('grants exactly maxConcurrent slots to a burst of concurrent acquires from both tasks', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 5 })
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? storeA : storeB).acquire(key, l)))
    expect(results.filter(r => r.status === 'acquired')).toHaveLength(5)
    expect(results.filter(r => r.status === 'busy')).toHaveLength(55)
  })

  it('opens after consecutive provider failures reported by different tasks, and refuses with the remaining time', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10, openMs: 10_000 })
    for (const store of [storeA, storeB, storeA]) await store.release(key, await acquired(store, key, l), 'provider_failure', l)
    const refused = await storeB.acquire(key, l)
    expect(refused.status).toBe('open')
    if (refused.status === 'open') expect(refused.retryAfterMs).toBeGreaterThan(9_000)
  })

  it('a success resets the consecutive count; "other" outcomes do not count', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10 })
    const report = async (outcome: 'ok' | 'provider_failure' | 'other') => storeA.release(key, await acquired(storeA, key, l), outcome, l)
    await report('provider_failure'); await report('provider_failure'); await report('ok')
    await report('provider_failure'); await report('other'); await report('provider_failure')
    await expect(storeB.acquire(key, l)).resolves.toMatchObject({ status: 'acquired' })
  })

  it('half-open lets exactly one probe through; a successful probe closes the circuit', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10, failureThreshold: 1, openMs: 150 })
    await storeA.release(key, await acquired(storeA, key, l), 'provider_failure', l)
    expect((await storeB.acquire(key, l)).status).toBe('open')
    await sleep(200)
    const probe = await acquired(storeB, key, l)
    expect((await storeA.acquire(key, l)).status).toBe('open')
    await storeB.release(key, probe, 'ok', l)
    const after = await Promise.all([storeA.acquire(key, l), storeB.acquire(key, l)])
    expect(after.map(r => r.status)).toEqual(['acquired', 'acquired'])
  })

  it('a failed probe re-opens the circuit for a full period', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10, failureThreshold: 1, openMs: 150 })
    await storeA.release(key, await acquired(storeA, key, l), 'provider_failure', l)
    await sleep(200)
    const probe = await acquired(storeA, key, l)
    await storeA.release(key, probe, 'provider_failure', l)
    const refused = await storeB.acquire(key, l)
    expect(refused.status).toBe('open')
    if (refused.status === 'open') expect(refused.retryAfterMs).toBeGreaterThan(100)
  })

  it('a probe whose task died is replaced once its lease lapses', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10, failureThreshold: 1, openMs: 100, slotTtlMs: 150 })
    await storeA.release(key, await acquired(storeA, key, l), 'provider_failure', l)
    await sleep(130)
    await acquired(storeA, key, l) // probe; never released
    expect((await storeB.acquire(key, l)).status).toBe('open')
    await sleep(200)
    await expect(storeB.acquire(key, l)).resolves.toMatchObject({ status: 'acquired' })
  })

  it('a slot whose task died frees capacity when its lease lapses', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 1, slotTtlMs: 120 })
    await acquired(storeA, key, l)
    await expect(storeB.acquire(key, l)).resolves.toEqual({ status: 'busy' })
    await sleep(180)
    await expect(storeB.acquire(key, l)).resolves.toMatchObject({ status: 'acquired' })
  })

  it('late failures from calls started before the circuit opened do not extend it', async () => {
    const key = gateKey()
    const l = limits({ maxConcurrent: 10, failureThreshold: 1, openMs: 300 })
    const straggler = await acquired(storeB, key, l)
    await storeA.release(key, await acquired(storeA, key, l), 'provider_failure', l)
    await sleep(150)
    await storeB.release(key, straggler, 'provider_failure', l)
    const refused = await storeA.acquire(key, l)
    if (refused.status !== 'open') throw new Error('expected open')
    expect(refused.retryAfterMs).toBeLessThan(200)
  })

  it('both keys carry an idle expiry', async () => {
    const key = gateKey()
    const l = limits()
    await storeA.release(key, await acquired(storeA, key, l), 'provider_failure', l)
    await acquired(storeA, key, l) // keep one slot so the sorted set exists
    for (const suffix of ['slots', 'state']) {
      const ttl = await taskA.eval("return redis.call('PTTL', KEYS[1])", [`{${key}}:${suffix}`], [])
      expect(ttl).toBeGreaterThan(86_000_000)
    }
  })

  it('drives SharedConnectorGate end to end: failures in one task open the circuit for the other', async () => {
    const connectorId = `connector-${process.pid}-${n++}`
    const make = (store: RedisGateStore) => new SharedConnectorGate({ tenantId: 'tenant-test', connectorId, store, whenStoreUnavailable: new InProcessGate(), limits: { failureThreshold: 2, openMs: 10_000 } })
    const gateA = make(storeA)
    const gateB = make(storeB)
    const read = { name: 'search', kind: 'read' as const }
    for (let i = 0; i < 2; i++) (await gateA.acquire(read))('provider_failure')
    await sleep(50) // release is fire-and-forget
    await expect(gateB.acquire(read)).rejects.toMatchObject({ code: 'circuit_open', delivery: 'not_sent' })
  })
})
