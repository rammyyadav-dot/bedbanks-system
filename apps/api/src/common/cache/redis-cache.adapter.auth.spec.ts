import { createServer, type Server } from 'net'
import { RedisCacheAdapter } from './redis-cache.adapter'

// WP3 / ADR 0056: ElastiCache is configured with an AUTH token (and TLS). The URL the platform builds is rediss://:<token>@host:6379
// (empty username). This proves the adapter's handshake for that shape against an in-process RESP server; TLS only changes the socket factory.

type Server_ = { server: Server; port: number; commands: string[][] }

function parseCommand(buffer: string): { parts: string[]; rest: string } | null {
  if (!buffer.startsWith('*')) return null
  const lines = buffer.split('\r\n')
  const count = Number(lines[0]?.slice(1))
  const parts: string[] = []
  let i = 1
  for (let n = 0; n < count; n++) {
    const len = Number(lines[i]?.slice(1))
    const value = lines[i + 1]
    if (!Number.isFinite(len) || value === undefined || value.length !== len) return null
    parts.push(value)
    i += 2
  }
  return { parts, rest: lines.slice(i).join('\r\n') }
}

async function fakeRedis(expectedAuth: string[] | null): Promise<Server_> {
  const commands: string[][] = []
  const server = createServer((socket) => {
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString()
      for (;;) {
        const cmd = parseCommand(buf)
        if (!cmd) return
        buf = cmd.rest
        commands.push(cmd.parts)
        const name = cmd.parts[0]?.toUpperCase()
        if (name === 'AUTH') {
          const ok = expectedAuth !== null && JSON.stringify(cmd.parts.slice(1)) === JSON.stringify(expectedAuth)
          socket.write(ok ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n')
        } else if (expectedAuth !== null && !commands.some((c) => c[0]?.toUpperCase() === 'AUTH')) {
          socket.write('-NOAUTH Authentication required.\r\n')
        } else if (name === 'GET') socket.write('$-1\r\n')
        else socket.write('+OK\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port, commands }
}

describe('RedisCacheAdapter AUTH handshake (ElastiCache AUTH token)', () => {
  const open: Server[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))))
  })
  const start = async (expected: string[] | null) => {
    const s = await fakeRedis(expected)
    open.push(s.server)
    return s
  }

  it('sends AUTH <token> for a password-only URL (rediss://:token@host), before the command', async () => {
    const s = await start(['tok3n'])
    const redis = new RedisCacheAdapter(`redis://:tok3n@127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).resolves.toBeNull()
    expect(s.commands[0]).toEqual(['AUTH', 'tok3n'])
    expect(s.commands[1]).toEqual(['GET', 'k'])
  })

  it('sends AUTH <user> <password> when a username is present (RBAC-style URL)', async () => {
    const s = await start(['fbeds', 'pw'])
    const redis = new RedisCacheAdapter(`redis://fbeds:pw@127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).resolves.toBeNull()
    expect(s.commands[0]).toEqual(['AUTH', 'fbeds', 'pw'])
  })

  it('fails closed when the token is wrong, and never issues the data command', async () => {
    const s = await start(['right'])
    const redis = new RedisCacheAdapter(`redis://:wrong@127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).rejects.toThrow()
    expect(s.commands.some((c) => c[0] === 'GET')).toBe(false)
  })

  it('a server that requires AUTH rejects a URL without credentials (no silent fallback)', async () => {
    const s = await start(['tok3n'])
    const redis = new RedisCacheAdapter(`redis://127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).rejects.toThrow()
  })

  it('does not send AUTH when the URL has no credentials and the server does not need it', async () => {
    const s = await start(null)
    const redis = new RedisCacheAdapter(`redis://127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).resolves.toBeNull()
    expect(s.commands.some((c) => c[0] === 'AUTH')).toBe(false)
  })

  it('decodes percent-encoded passwords', async () => {
    const s = await start(['a/b+c'])
    const redis = new RedisCacheAdapter(`redis://:a%2Fb%2Bc@127.0.0.1:${s.port}`, 1_000)
    await expect(redis.get('k')).resolves.toBeNull()
    expect(s.commands[0]).toEqual(['AUTH', 'a/b+c'])
  })
})
