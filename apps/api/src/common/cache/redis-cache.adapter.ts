import { randomUUID } from 'crypto'
import { connect as connectTcp, type Socket } from 'net'
import { connect as connectTls, type TLSSocket } from 'tls'
import type { CachePort, CacheWriteOptions, CoordinationPort, LockLease } from './cache.port'

type RedisReply = string | number | null

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export class RedisCacheAdapter implements CachePort, CoordinationPort {
  private readonly url: URL
  private readonly timeoutMs: number
  private current: RedisConnection | null = null

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

  /** Drops the shared connection. In-flight commands are rejected; the next command reconnects. */
  close(): void {
    const connection = this.current
    this.current = null
    connection?.fail(new Error('Redis adapter closed'))
  }

  private async command(parts: string[]): Promise<RedisReply> {
    const connection = await this.connection()
    return connection.send(parts)
  }

  /**
   * One authenticated connection is shared by all callers and commands are pipelined on it. Reconnecting per command cost a TCP/TLS
   * handshake plus AUTH and SELECT round trips, which dominated cache latency. A timeout or protocol fault destroys the connection
   * because reply order can no longer be trusted; the next command opens a fresh one.
   */
  private connection(): Promise<RedisConnection> {
    if (this.current) return this.current.ready
    const connection = new RedisConnection(this.url, this.timeoutMs)
    this.current = connection
    connection.ready.catch(() => { if (this.current === connection) this.current = null })
    connection.onClosed = () => { if (this.current === connection) this.current = null }
    return connection.ready
  }
}

interface PendingReply { resolve: (value: RedisReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type ParsedReply = { value: RedisReply; bytes: number } | { error: string; bytes: number }

class RedisConnection {
  readonly ready: Promise<RedisConnection>
  onClosed: () => void = () => undefined
  private socket: Socket | TLSSocket | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private readonly pending: PendingReply[] = []
  private dead: Error | null = null

  constructor(private readonly url: URL, private readonly timeoutMs: number) {
    this.ready = this.open().then(async () => {
      if (this.url.username || this.url.password) {
        const auth = this.url.username
          ? ['AUTH', decodeURIComponent(this.url.username), decodeURIComponent(this.url.password)]
          : ['AUTH', decodeURIComponent(this.url.password)]
        if (await this.send(auth) !== 'OK') throw new Error('Redis authentication failed')
      }
      const db = this.url.pathname.replace(/^\//, '')
      if (db && db !== '0' && await this.send(['SELECT', db]) !== 'OK') throw new Error('Redis database selection failed')
      return this
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error('Redis connection failed')
      this.fail(failure)
      throw failure
    })
  }

  send(parts: string[]): Promise<RedisReply> {
    const socket = this.socket
    if (this.dead || !socket) return Promise.reject(this.dead ?? new Error('Redis connection is not open'))
    const payload = `*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Redis command timeout')), this.timeoutMs)
      this.pending.push({ resolve, reject, timer })
      socket.write(payload)
    })
  }

  fail(error: Error): void {
    if (this.dead) return
    this.dead = error
    this.socket?.destroy()
    for (const entry of this.pending.splice(0)) { clearTimeout(entry.timer); entry.reject(error) }
    this.onClosed()
  }

  private open(): Promise<void> {
    const port = Number(this.url.port || 6379)
    const host = this.url.hostname
    return new Promise((resolve, reject) => {
      const secure = this.url.protocol === 'rediss:'
      const socket = secure ? connectTls({ host, port, servername: host }) : connectTcp({ host, port })
      const timer = setTimeout(() => socket.destroy(new Error('Redis connection timeout')), this.timeoutMs)
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer)
        socket.setNoDelay(true)
        // An idle cache connection must not keep the process alive.
        socket.unref()
        this.socket = socket
        // No encoding is set, so chunks are Buffers; the guard keeps the RESP parser byte-exact.
        socket.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
        socket.on('error', error => this.fail(error))
        socket.on('close', () => this.fail(new Error('Redis connection closed')))
        resolve()
      })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      for (;;) {
        const parsed = this.parse(this.buffer)
        if (!parsed) return
        this.buffer = this.buffer.subarray(parsed.bytes)
        const entry = this.pending.shift()
        if (!entry) throw new Error('Unexpected Redis reply')
        clearTimeout(entry.timer)
        if ('error' in parsed) entry.reject(new Error(`Redis command rejected: ${parsed.error}`))
        else entry.resolve(parsed.value)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid Redis response'))
    }
  }

  private parse(buffer: Buffer): ParsedReply | null {
    if (!buffer.length) return null
    const lineEnd = buffer.indexOf('\r\n')
    if (lineEnd < 0) return null
    const prefix = String.fromCharCode(buffer[0])
    const line = buffer.subarray(1, lineEnd).toString('utf8')
    if (prefix === '+') return { value: line, bytes: lineEnd + 2 }
    if (prefix === ':') return { value: Number(line), bytes: lineEnd + 2 }
    if (prefix === '-') return { error: line.split(' ')[0], bytes: lineEnd + 2 }
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
