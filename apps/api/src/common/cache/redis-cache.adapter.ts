import { randomUUID } from 'crypto'
import { connect as connectTcp, type Socket } from 'net'
import { connect as connectTls, type TLSSocket } from 'tls'
import type { CachePort, CacheWriteOptions, CoordinationPort, LockLease } from './cache.port'

type RedisReply = string | number | null

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export class RedisCacheAdapter implements CachePort, CoordinationPort {
  private readonly url: URL
  private readonly timeoutMs: number

  constructor(redisUrl: string, timeoutMs = 1_000) {
    this.url = new URL(redisUrl)
    if (!['redis:', 'rediss:'].includes(this.url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://')
    this.timeoutMs = timeoutMs
  }

  async get<T>(key: string): Promise<T | null> {
    const reply = await this.command(['GET', key])
    if (reply === null) return null
    if (typeof reply !== 'string') throw new Error('Unexpected Redis GET response')
    return JSON.parse(reply) as T
  }

  async set<T>(key: string, value: T, options: CacheWriteOptions): Promise<void> {
    this.assertTtl(options.ttlMs)
    const reply = await this.command(['SET', key, JSON.stringify(value), 'PX', String(options.ttlMs)])
    if (reply !== 'OK') throw new Error('Redis cache write failed')
  }

  async delete(key: string): Promise<void> {
    await this.command(['DEL', key])
  }

  async acquire(key: string, ttlMs: number): Promise<LockLease | null> {
    this.assertTtl(ttlMs)
    const token = randomUUID()
    const reply = await this.command(['SET', key, token, 'NX', 'PX', String(ttlMs)])
    return reply === 'OK' ? { key, token } : null
  }

  async release(lease: LockLease): Promise<void> {
    await this.command(['EVAL', RELEASE_SCRIPT, '1', lease.key, lease.token])
  }

  private assertTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('A bounded positive Redis TTL is required')
  }

  private async command(parts: string[]): Promise<RedisReply> {
    const socket = await this.open()
    try {
      if (this.url.username || this.url.password) {
        const auth = this.url.username
          ? ['AUTH', decodeURIComponent(this.url.username), decodeURIComponent(this.url.password)]
          : ['AUTH', decodeURIComponent(this.url.password)]
        const authenticated = await this.exchange(socket, auth)
        if (authenticated !== 'OK') throw new Error('Redis authentication failed')
      }
      const db = this.url.pathname.replace(/^\//, '')
      if (db && db !== '0') {
        const selected = await this.exchange(socket, ['SELECT', db])
        if (selected !== 'OK') throw new Error('Redis database selection failed')
      }
      return await this.exchange(socket, parts)
    } finally {
      socket.destroy()
    }
  }

  private open(): Promise<Socket | TLSSocket> {
    const port = Number(this.url.port || 6379)
    const host = this.url.hostname
    return new Promise((resolve, reject) => {
      const socket = this.url.protocol === 'rediss:'
        ? connectTls({ host, port, servername: host })
        : connectTcp({ host, port })
      const timer = setTimeout(() => socket.destroy(new Error('Redis connection timeout')), this.timeoutMs)
      socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
  }

  private exchange(socket: Socket | TLSSocket, parts: string[]): Promise<RedisReply> {
    const payload = `*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => finish(new Error('Redis command timeout')), this.timeoutMs)
      const finish = (error?: Error, value?: RedisReply) => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        error ? reject(error) : resolve(value ?? null)
      }
      const onError = (error: Error) => finish(error)
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        try {
          const parsed = this.parse(buffer)
          if (parsed) finish(undefined, parsed.value)
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Invalid Redis response'))
        }
      }
      socket.on('data', onData)
      socket.once('error', onError)
      socket.write(payload)
    })
  }

  private parse(buffer: Buffer): { value: RedisReply; bytes: number } | null {
    if (!buffer.length) return null
    const lineEnd = buffer.indexOf('\r\n')
    if (lineEnd < 0) return null
    const prefix = String.fromCharCode(buffer[0])
    const line = buffer.subarray(1, lineEnd).toString('utf8')
    if (prefix === '+') return { value: line, bytes: lineEnd + 2 }
    if (prefix === ':') return { value: Number(line), bytes: lineEnd + 2 }
    if (prefix === '-') throw new Error(`Redis command rejected: ${line.split(' ')[0]}`)
    if (prefix === '$') {
      const length = Number(line)
      if (length === -1) return { value: null, bytes: lineEnd + 2 }
      const start = lineEnd + 2
      const end = start + length
      if (buffer.length < end + 2) return null
      return { value: buffer.subarray(start, end).toString('utf8'), bytes: end + 2 }
    }
    throw new Error('Unsupported Redis response type')
  }
}

export function redisFromEnvironment(): RedisCacheAdapter | null {
  const redisUrl = process.env.REDIS_URL?.trim()
  if (!redisUrl) return null
  const configured = Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 1_000)
  const timeout = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 5_000) : 1_000
  return new RedisCacheAdapter(redisUrl, timeout)
}
