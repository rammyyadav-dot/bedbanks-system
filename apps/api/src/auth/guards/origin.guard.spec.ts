import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { OriginGuard } from './origin.guard'
import type { AppConfig } from '../../config/configuration'

const ADMIN = 'https://admin.example'
const AGENT = 'https://agent.example'

function guardWith(settings: Record<string, unknown>): OriginGuard {
  return new OriginGuard({ get: (key: string) => settings[key] } as unknown as ConfigService<AppConfig>)
}

function context(method: string, origin?: string): ExecutionContext {
  const req = { method, get: (name: string) => (name.toLowerCase() === 'origin' ? origin : undefined) }
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext
}

describe('OriginGuard', () => {
  const guard = guardWith({ adminOrigin: ADMIN, trustedOrigins: [AGENT] })

  it('allows safe methods from anywhere', () => {
    expect(guard.canActivate(context('GET', 'https://evil.example'))).toBe(true)
  })

  it.each([ADMIN, AGENT])('allows a login-style POST from the trusted origin %s', (origin) => {
    expect(guard.canActivate(context('POST', origin))).toBe(true)
  })

  it('rejects a POST from an unlisted origin, a missing origin, or null', () => {
    for (const origin of ['https://evil.example', undefined, 'null']) {
      expect(() => guard.canActivate(context('POST', origin))).toThrow(ForbiddenException)
    }
  })

  it('trusts only Admin when no extra portals are configured', () => {
    const adminOnly = guardWith({ adminOrigin: ADMIN, trustedOrigins: [] })
    expect(adminOnly.canActivate(context('POST', ADMIN))).toBe(true)
    expect(() => adminOnly.canActivate(context('POST', AGENT))).toThrow(ForbiddenException)
  })
})
