import { randomUUID } from 'crypto'
import type { GateAcquireResult, GateOutcome, GateStore, SharedGateLimits } from '@bedbanks/connectors-core'

/** The one Redis capability the gate needs. `RedisCacheAdapter` provides it. */
export interface RedisScriptRunner { eval(script: string, keys: string[], args: string[]): Promise<string | number | null> }

/**
 * Redis state for `SharedConnectorGate` (ADR 0075 amendment 1). Each operation is one Lua script, so it is atomic across
 * every API task. Time comes from the Redis server (`TIME`), never from a task clock, so tasks with skewed clocks agree.
 *
 * Keys share a hash tag so they land in one cluster slot:
 *  - `{gate}:slots`  sorted set, member = slot id, score = lease expiry (ms). Lapsed leases are pruned on every acquire.
 *  - `{gate}:state`  hash: `failures` (consecutive provider failures), `open_until` (ms; present while open or
 *                    half-open), `probe` (slot id of the single half-open probe).
 * Both keys expire after a day without writes, so an idle connector leaves nothing behind.
 */
const IDLE_EXPIRY_MS = 86_400_000

const PREAMBLE = `
local slots, state = KEYS[1], KEYS[2]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local keep = math.max(${IDLE_EXPIRY_MS}, tonumber(ARGV[3]) * 2)
local function touch() redis.call('PEXPIRE', slots, keep); redis.call('PEXPIRE', state, keep) end
`

// ARGV: maxConcurrent, slotTtlMs, openMs, slotId
const ACQUIRE = `${PREAMBLE}
local max, ttl, slotId = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', slots, '-inf', now)
local openUntil = tonumber(redis.call('HGET', state, 'open_until') or '0')
if openUntil > 0 then
  if now < openUntil then return 'open:' .. (openUntil - now) end
  local probe = redis.call('HGET', state, 'probe')
  if probe then
    local leaseEnd = redis.call('ZSCORE', slots, probe)
    if leaseEnd then return 'open:' .. math.max(0, tonumber(leaseEnd) - now) end
  end
  redis.call('HSET', state, 'probe', slotId)
  redis.call('ZADD', slots, now + ttl, slotId)
  touch()
  return 'acquired'
end
if redis.call('ZCARD', slots) >= max then return 'busy' end
redis.call('ZADD', slots, now + ttl, slotId)
touch()
return 'acquired'
`

// ARGV: failureThreshold, outcome, openMs, slotId
const RELEASE = `${PREAMBLE}
local threshold, outcome, openMs, slotId = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3]), ARGV[4]
redis.call('ZREM', slots, slotId)
local isProbe = redis.call('HGET', state, 'probe') == slotId
if isProbe then redis.call('HDEL', state, 'probe') end
local closed = redis.call('HEXISTS', state, 'open_until') == 0
if outcome == 'ok' then
  if isProbe or closed then redis.call('HDEL', state, 'failures', 'open_until') end
elseif outcome == 'provider_failure' then
  if isProbe then
    redis.call('HSET', state, 'open_until', now + openMs, 'failures', 0)
  elseif closed then
    if redis.call('HINCRBY', state, 'failures', 1) >= threshold then
      redis.call('HSET', state, 'open_until', now + openMs, 'failures', 0)
    end
  end
end
touch()
return 'released'
`

const OPEN = /^open:(\d{1,12})$/

export class RedisGateStore implements GateStore {
  constructor(private readonly redis: RedisScriptRunner, private readonly newSlotId: () => string = randomUUID) {}

  async acquire(gateKey: string, limits: SharedGateLimits): Promise<GateAcquireResult> {
    const slotId = this.newSlotId()
    const reply = await this.redis.eval(ACQUIRE, keys(gateKey), [String(limits.maxConcurrent), String(limits.slotTtlMs), String(limits.openMs), slotId])
    if (reply === 'acquired') return { status: 'acquired', slotId }
    if (reply === 'busy') return { status: 'busy' }
    const open = typeof reply === 'string' ? OPEN.exec(reply) : null
    if (open) return { status: 'open', retryAfterMs: Number(open[1]) }
    throw new Error('Unexpected gate acquire reply')
  }

  async release(gateKey: string, slotId: string, outcome: GateOutcome, limits: SharedGateLimits): Promise<void> {
    const reply = await this.redis.eval(RELEASE, keys(gateKey), [String(limits.failureThreshold), outcome, String(limits.openMs), slotId])
    if (reply !== 'released') throw new Error('Unexpected gate release reply')
  }
}

function keys(gateKey: string): string[] {
  return [`{${gateKey}}:slots`, `{${gateKey}}:state`]
}
