import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { CrossSiteRequestGuard } from './cross-site-request.guard'
import type { AppConfig } from '../../config/configuration'

const ADMIN = 'https://admin.example'
const AGENT = 'https://agent.example'
const settings: Record<string, unknown> = { adminOrigin: ADMIN, trustedOrigins: [AGENT] }
const guard = new CrossSiteRequestGuard({ get: (key: string) => settings[key] } as unknown as ConfigService<AppConfig>)

function context(method: string, headers: Record<string, string> = {}): ExecutionContext {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const req = { method, get: (name: string) => lower[name.toLowerCase()] }
  return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext
}

describe('CrossSiteRequestGuard', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe %s requests from any origin', (method) => {
    expect(guard.canActivate(context(method, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }))).toBe(true)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allows %s from the Admin origin', (method) => {
    expect(guard.canActivate(context(method, { Origin: ADMIN, 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allows %s from a listed portal origin', (method) => {
    expect(guard.canActivate(context(method, { Origin: AGENT, 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  })

  it('rejects an origin that only shares a prefix or scheme with a trusted one', () => {
    for (const origin of ['http://agent.example', 'https://agent.example.evil.example', 'https://agent.example:8443']) {
      expect(() => guard.canActivate(context('POST', { Origin: origin }))).toThrow(ForbiddenException)
    }
  })

  it.each(['POST', 'PATCH', 'DELETE'])('rejects %s from a foreign origin', (method) => {
    expect(() => guard.canActivate(context(method, { Origin: 'https://evil.example' }))).toThrow(ForbiddenException)
  })

  it('rejects the opaque null origin sent by sandboxed documents', () => {
    expect(() => guard.canActivate(context('POST', { Origin: 'null' }))).toThrow(ForbiddenException)
  })

  it('rejects cross-site fetch metadata even without an Origin header', () => {
    expect(() => guard.canActivate(context('POST', { 'Sec-Fetch-Site': 'cross-site' }))).toThrow(ForbiddenException)
  })

  it('allows non-browser clients that send no Origin', () => {
    expect(guard.canActivate(context('POST'))).toBe(true)
  })

  it('ignores non-HTTP execution contexts', () => {
    expect(guard.canActivate({ getType: () => 'rpc' } as unknown as ExecutionContext)).toBe(true)
  })
})
