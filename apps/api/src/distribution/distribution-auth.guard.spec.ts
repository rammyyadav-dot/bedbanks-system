import { ForbiddenException, Logger, ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DISTRIBUTION_PRINCIPAL_KEY, DistributionAuthGuard, type DistributionRequirement } from './distribution-auth.guard'
import { newAccessToken, newCredentialMaterial, sha256Hex } from './distribution-credentials'

const row = (over: Record<string, unknown> = {}) => ({ tenant_id: 't1', agency_id: 'a1', client_id: 'c1', ref: 'cred1', kind: 'API_KEY', scopes: ['SEARCH', 'BOOK'], ip_allowlist: [], search_per_minute: 120, check_rate_per_minute: 30, book_per_minute: 10, ...over })

function setup(options: { authorization?: string; rows?: unknown[]; fail?: boolean; required?: DistributionRequirement; ip?: string; cookie?: string }) {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join('?'), values })
      if (options.fail) throw new Error('connection refused')
      return options.rows ?? []
    }),
  }
  const reflector = { getAllAndOverride: () => options.required } as unknown as Reflector
  const headers: Record<string, string> = {}
  const request: Record<string, unknown> = {
    header: (name: string) => (name === 'authorization' ? options.authorization : undefined),
    ip: options.ip ?? '203.0.113.9', requestId: 'req-00000001', cookies: options.cookie ? { fbeds_session: options.cookie } : {},
  }
  const response = { setHeader: (k: string, v: string) => { headers[k] = v } }
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext
  return { guard: new DistributionAuthGuard(reflector, prisma as never), context, request, headers, queries, prisma }
}

describe('DistributionAuthGuard', () => {
  let warn: jest.SpyInstance
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined) })
  afterEach(() => jest.restoreAllMocks())

  it('authenticates an API key through the database function with only the key id and the secret hash, and attaches the principal', async () => {
    const m = newCredentialMaterial()
    const s = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row()], required: 'SEARCH' })
    await expect(s.guard.canActivate(s.context)).resolves.toBe(true)
    expect(s.queries).toHaveLength(1)
    expect(s.queries[0].sql).toContain('"fbeds_distribution_authenticate_key"')
    expect(s.queries[0].values).toEqual([m.keyId, m.secretHash])
    expect(JSON.stringify(s.queries)).not.toContain(m.secret)
    expect(s.request[DISTRIBUTION_PRINCIPAL_KEY]).toEqual({ tenantId: 't1', agencyId: 'a1', clientId: 'c1', authenticatedWith: 'api_key', credentialRef: 'cred1', scopes: ['SEARCH', 'BOOK'], limits: { searchPerMinute: 120, checkRatePerMinute: 30, bookPerMinute: 10 } })
  })

  it('authenticates a bearer token by its hash', async () => {
    const token = newAccessToken()
    const s = setup({ authorization: `Bearer ${token}`, rows: [row({ kind: null, ref: 'tok1' })], required: 'SELF' })
    await expect(s.guard.canActivate(s.context)).resolves.toBe(true)
    expect(s.queries[0].sql).toContain('"fbeds_distribution_authenticate_token"')
    expect(s.queries[0].values).toEqual([sha256Hex(token)])
    expect(s.request[DISTRIBUTION_PRINCIPAL_KEY]).toEqual(expect.objectContaining({ authenticatedWith: 'access_token', credentialRef: 'tok1' }))
  })

  it('refuses every bad credential with the same 401 and a Bearer challenge, without querying malformed input', async () => {
    const m = newCredentialMaterial()
    const cases = [undefined, '', 'ApiKey', `Basic ${Buffer.from('a:b').toString('base64')}`, `ApiKey ${m.apiKey}x`, 'Bearer not-a-token', `Token ${m.apiKey}`]
    for (const authorization of cases) {
      const s = setup({ authorization, rows: [row()], required: 'SELF' })
      await expect(s.guard.canActivate(s.context)).rejects.toThrow(UnauthorizedException)
      expect(s.queries).toHaveLength(0)
      expect(s.headers['WWW-Authenticate']).toMatch(/^Bearer realm="fbeds-distribution"/)
    }
    const unknown = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [], required: 'SELF' })
    await expect(unknown.guard.canActivate(unknown.context)).rejects.toThrow('Partner credential is missing, invalid or not active')
    expect(unknown.headers['WWW-Authenticate']).toBe('Bearer realm="fbeds-distribution", error="invalid_token"')
  })

  it('ignores a session cookie: a session is not a partner credential', async () => {
    const s = setup({ cookie: 'a-valid-looking-session', required: 'SELF' })
    await expect(s.guard.canActivate(s.context)).rejects.toThrow(UnauthorizedException)
    expect(s.queries).toHaveLength(0)
  })

  it('refuses an OAuth client secret presented as an API key', async () => {
    const m = newCredentialMaterial()
    const s = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row({ kind: 'OAUTH_CLIENT' })], required: 'SELF' })
    await expect(s.guard.canActivate(s.context)).rejects.toThrow(UnauthorizedException)
    expect(s.request[DISTRIBUTION_PRINCIPAL_KEY]).toBeUndefined()
  })

  it('enforces the CIDR allowlist against the connection address and fails closed', async () => {
    const m = newCredentialMaterial()
    const inside = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row({ ip_allowlist: ['203.0.113.0/24'] })], required: 'SELF' })
    await expect(inside.guard.canActivate(inside.context)).resolves.toBe(true)
    const outside = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row({ ip_allowlist: ['198.51.100.0/24'] })], required: 'SELF' })
    await expect(outside.guard.canActivate(outside.context)).rejects.toThrow(UnauthorizedException)
    expect(outside.request[DISTRIBUTION_PRINCIPAL_KEY]).toBeUndefined()
  })

  it('requires the declared scope (403 insufficient_scope), admits SELF without one, and fails closed when nothing is declared', async () => {
    const m = newCredentialMaterial()
    const missing = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row({ scopes: ['SEARCH'] })], required: 'BOOK' })
    await expect(missing.guard.canActivate(missing.context)).rejects.toThrow(ForbiddenException)
    expect(missing.headers['WWW-Authenticate']).toBe('Bearer realm="fbeds-distribution", error="insufficient_scope"')
    const self = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row({ scopes: ['SEARCH'] })], required: 'SELF' })
    await expect(self.guard.canActivate(self.context)).resolves.toBe(true)
    const undeclared = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [row()], required: undefined })
    await expect(undeclared.guard.canActivate(undeclared.context)).rejects.toThrow(ForbiddenException)
  })

  it('answers 503 when the database cannot authenticate, never 401 or a pass', async () => {
    const m = newCredentialMaterial()
    const s = setup({ authorization: `ApiKey ${m.apiKey}`, fail: true, required: 'SELF' })
    await expect(s.guard.canActivate(s.context)).rejects.toThrow(ServiceUnavailableException)
  })

  it('logs the refusal reason and request id, never the credential or its hash', async () => {
    const m = newCredentialMaterial()
    const s = setup({ authorization: `ApiKey ${m.apiKey}`, rows: [], required: 'SELF' })
    await expect(s.guard.canActivate(s.context)).rejects.toThrow(UnauthorizedException)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('unknown_or_inactive_credential')
    expect(logged).toContain('req-00000001')
    for (const secret of [m.apiKey, m.secret, m.secretHash, m.keyId]) expect(logged).not.toContain(secret)
  })
})
