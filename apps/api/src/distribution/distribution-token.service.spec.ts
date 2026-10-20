import { Logger } from '@nestjs/common'
import { isAccessToken, newCredentialMaterial, sha256Hex } from './distribution-credentials'
import { DistributionTokenService } from './distribution-token.service'

function setup(rows: unknown[] | 'fail' = [{ outcome: 'issued', token_id: 'dat_1', scopes: ['SEARCH', 'BOOK'], client_id: 'c1' }]) {
  const calls: unknown[][] = []
  const prisma = { $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); if (rows === 'fail') throw new Error('down'); return rows }) }
  return { service: new DistributionTokenService(prisma as never), calls }
}
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`

describe('DistributionTokenService (OAuth 2.0 client credentials)', () => {
  let logs: jest.SpyInstance[]
  beforeEach(() => { logs = (['log', 'warn', 'error'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined)) })
  afterEach(() => jest.restoreAllMocks())
  const m = newCredentialMaterial()

  it('issues a token with HTTP Basic: only hashes reach the database, and the token is returned once in the RFC 6749 shape', async () => {
    const { service, calls } = setup()
    const out = await service.issue({ authorization: basic(m.keyId, m.secret), body: { grant_type: 'client_credentials' }, requestId: 'req-00000001' })
    expect(out.status).toBe(200)
    if (out.status !== 200) throw new Error('expected 200')
    expect(out.body).toEqual({ access_token: expect.any(String), token_type: 'Bearer', expires_in: 900, scope: 'search book' })
    expect(isAccessToken(out.body.access_token)).toBe(true)
    expect(calls).toEqual([[m.keyId, m.secretHash, sha256Hex(out.body.access_token), [], 900, 'req-00000001']])
    expect(JSON.stringify(calls)).not.toContain(m.secret)
    const logged = JSON.stringify(logs.map((l) => l.mock.calls))
    for (const secret of [m.secret, m.secretHash, out.body.access_token]) expect(logged).not.toContain(secret)
  })

  it('accepts body client credentials and a scope subset', async () => {
    const { service, calls } = setup([{ outcome: 'issued', token_id: 'dat_1', scopes: ['SEARCH'], client_id: 'c1' }])
    const out = await service.issue({ authorization: undefined, body: { grant_type: 'client_credentials', client_id: m.keyId, client_secret: m.secret, scope: 'search' }, requestId: undefined })
    expect(out).toEqual({ status: 200, body: expect.objectContaining({ scope: 'search' }) })
    expect(calls[0][3]).toEqual(['SEARCH'])
  })

  it('checks client authentication first, then the request, all before any query', async () => {
    const { service, calls } = setup()
    const cases: Array<[Record<string, unknown>, string | undefined, number, string]> = [
      [{}, undefined, 401, 'invalid_client'],
      [{ grant_type: 'password' }, undefined, 401, 'invalid_client'],
      [{}, basic(m.keyId, m.secret), 400, 'invalid_request'],
      [{ grant_type: 'password' }, basic(m.keyId, m.secret), 400, 'unsupported_grant_type'],
      [{ grant_type: 'client_credentials' }, undefined, 401, 'invalid_client'],
      [{ grant_type: 'client_credentials', client_id: m.keyId, client_secret: m.secret }, basic(m.keyId, m.secret), 400, 'invalid_request'],
      [{ grant_type: 'client_credentials', client_id: m.keyId, client_secret: 'short' }, undefined, 401, 'invalid_client'],
      [{ grant_type: 'client_credentials' }, 'Basic !!!', 401, 'invalid_client'],
      [{ grant_type: 'client_credentials', scope: 'admin' }, basic(m.keyId, m.secret), 400, 'invalid_scope'],
    ]
    for (const [body, authorization, status, error] of cases) {
      const out = await service.issue({ authorization, body, requestId: undefined })
      expect({ status: out.status, error: (out.body as { error?: string }).error }).toEqual({ status, error })
    }
    expect(calls).toHaveLength(0)
  })

  it('maps the database answers: no row is invalid_client (with a Basic challenge when Basic was used), invalid_scope is 400, a failure is 503', async () => {
    const refused = await setup([]).service.issue({ authorization: basic(m.keyId, m.secret), body: { grant_type: 'client_credentials' }, requestId: undefined })
    expect(refused).toEqual({ status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed' }, basicChallenge: true })
    const scope = await setup([{ outcome: 'invalid_scope', token_id: null, scopes: null, client_id: 'c1' }]).service.issue({ authorization: basic(m.keyId, m.secret), body: { grant_type: 'client_credentials', scope: 'cancel' }, requestId: undefined })
    expect(scope).toEqual(expect.objectContaining({ status: 400, body: expect.objectContaining({ error: 'invalid_scope' }) }))
    const down = await setup('fail').service.issue({ authorization: basic(m.keyId, m.secret), body: { grant_type: 'client_credentials' }, requestId: undefined })
    expect(down).toEqual({ status: 503, body: { error: 'temporarily_unavailable', error_description: 'Token issuance is temporarily unavailable' } })
  })
})
