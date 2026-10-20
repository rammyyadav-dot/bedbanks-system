import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { hashPassword } from '../src/auth/utils/password'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { newCredentialMaterial, sha256Hex } from '../src/distribution/distribution-credentials'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0075 amendment 4: partner authentication and OAuth token issuance over HTTP, with the whole application connected as the provisioned
 * NOSUPERUSER NOBYPASSRLS runtime login. The runtime holds EXECUTE on three functions and no privilege on any credential table.
 */
describe('distribution partner authentication (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `dauth-${Date.now()}-${randomBytes(3).toString('hex')}`
  const runtimePassword = randomBytes(24).toString('hex')
  const userPassword = 'distribution-user-password'
  let app: INestApplication
  let previousUrl: string | undefined
  let tenantId = ''
  let agencyId = ''
  let userId = ''
  let sessionCookie = ''

  const http = () => request(app.getHttpServer())
  const basic = (keyId: string, secret: string) => `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`
  const tokenRequest = () => http().post('/api/v1/distribution/v1/oauth/token').type('form')

  async function client(extra: Record<string, unknown> = {}) {
    return (await owner.distributionClient.create({ data: { tenantId, agencyId, name: `c-${randomBytes(4).toString('hex')}`, scopes: ['SEARCH', 'CHECKRATE', 'BOOK'], createdByUserId: userId, ...extra } as never })).id
  }
  async function credential(clientId: string, kind: 'API_KEY' | 'OAUTH_CLIENT') {
    const m = newCredentialMaterial()
    const row = await owner.distributionCredential.create({ data: { tenantId, clientId, kind, keyId: m.keyId, secretHash: m.secretHash, createdByUserId: userId } })
    return { ...m, id: row.id, clientId }
  }
  const issue = (cred: { keyId: string; secret: string }, scope?: string) =>
    tokenRequest().set('Authorization', basic(cred.keyId, cred.secret)).send({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) })

  beforeAll(async () => {
    await owner.$connect()
    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await owner.user.create({ data: { email: `${suffix}@example.test`, name: 'Operator', passwordHash: await hashPassword(userPassword), status: 'ACTIVE' } })).id
    await owner.membership.create({ data: { tenantId, userId, role: 'agent' } })
    agencyId = (await owner.agency.create({ data: { tenantId, code: `DA-${randomBytes(3).toString('hex').toUpperCase()}`, name: 'Partner Travel', createdById: userId } })).id
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    const login = await http().post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email: `${suffix}@example.test`, password: userPassword })
    sessionCookie = login.status === 200 ? (login.headers['set-cookie'][0] as string).split(';')[0] : ''
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const table of ['distribution_access_tokens', 'distribution_credentials', 'distribution_clients', 'AuditEvent', 'Agency', 'memberships']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      }
    })
    await owner.session.deleteMany({ where: { userId } }); await owner.user.deleteMany({ where: { id: userId } }); await owner.tenant.deleteMany({ where: { id: tenantId } })
    await owner.$disconnect()
  }, 60_000)

  it('DA-01 the runtime login passes the verifier (including the function contract) and cannot touch any credential table', async () => {
    const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      await expect(verifyApiRuntimeRole(runtime)).resolves.toEqual({ ok: true, failures: [] })
      for (const table of ['distribution_clients', 'distribution_credentials', 'distribution_access_tokens']) {
        await expect(runtime.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
        await expect(runtime.$executeRawUnsafe(`INSERT INTO "${table}" ("id") VALUES ('x')`)).rejects.toThrow(/permission denied/)
      }
      await expect(runtime.$queryRawUnsafe('SELECT "fbeds_booking_due_tenants"(now()::timestamp)')).rejects.toThrow(/permission denied/)
    } finally { await runtime.$disconnect() }
  })

  it('DA-02 client credentials (HTTP Basic) issue a 15-minute token in the RFC 6749 shape; only its hash is stored, with an audit event', async () => {
    const oauth = await credential(await client(), 'OAUTH_CLIENT')
    const res = await issue(oauth).expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({ access_token: expect.stringMatching(/^fbt_[A-Za-z0-9_-]{43}$/), token_type: 'Bearer', expires_in: 900, scope: 'search checkrate book' })
    const stored = await owner.distributionAccessToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(res.body.access_token) } })
    expect(stored).toEqual(expect.objectContaining({ tenantId, clientId: oauth.clientId, credentialId: oauth.id, scopes: ['SEARCH', 'CHECKRATE', 'BOOK'], revokedAt: null }))
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(900_000)
    expect(await owner.distributionAccessToken.count({ where: { tokenHash: res.body.access_token } })).toBe(0)
    const audit = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'distribution.token.issued', entityId: stored.id } })
    expect(audit).toEqual(expect.objectContaining({ actorType: 'SYSTEM', entityType: 'distribution_access_token' }))
    expect(audit.payload).toEqual(expect.objectContaining({ clientId: oauth.clientId, credentialId: oauth.id, scopes: ['SEARCH', 'CHECKRATE', 'BOOK'], ttlSeconds: 900 }))
    expect(JSON.stringify(audit.payload)).not.toContain(oauth.secret)
    expect(JSON.stringify(audit.payload)).not.toContain(res.body.access_token)
  })

  it('DA-03 body client credentials and scope subsets work; both methods at once, bad grants and unknown or ungranted scopes are refused without writing', async () => {
    const oauth = await credential(await client(), 'OAUTH_CLIENT')
    const viaBody = await tokenRequest().send({ grant_type: 'client_credentials', client_id: oauth.keyId, client_secret: oauth.secret, scope: 'search' }).expect(200)
    expect(viaBody.body.scope).toBe('search')
    const before = await owner.distributionAccessToken.count({ where: { clientId: oauth.clientId } })
    await tokenRequest().set('Authorization', basic(oauth.keyId, oauth.secret)).send({ grant_type: 'client_credentials', client_id: oauth.keyId, client_secret: oauth.secret }).expect(400, { error: 'invalid_request', error_description: 'Use one client authentication method, not both' })
    expect((await tokenRequest().set('Authorization', basic(oauth.keyId, oauth.secret)).send({ grant_type: 'password' }).expect(400)).body.error).toBe('unsupported_grant_type')
    expect((await tokenRequest().send({ grant_type: 'password' }).expect(401)).body.error).toBe('invalid_client')
    expect((await issue(oauth, 'admin').expect(400)).body.error).toBe('invalid_scope')
    expect((await issue(oauth, 'cancel').expect(400)).body.error).toBe('invalid_scope')
    expect(await owner.distributionAccessToken.count({ where: { clientId: oauth.clientId } })).toBe(before)
  })

  it('DA-04 a wrong secret, an unknown client or an API key at the token endpoint is invalid_client with a Basic challenge, and writes nothing', async () => {
    const oauth = await credential(await client(), 'OAUTH_CLIENT')
    const apiKey = await credential(oauth.clientId, 'API_KEY')
    for (const cred of [{ keyId: oauth.keyId, secret: newCredentialMaterial().secret }, newCredentialMaterial(), apiKey]) {
      const res = await issue(cred).expect(401)
      expect(res.body).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' })
      expect(res.headers['www-authenticate']).toBe('Basic realm="fbeds-distribution"')
    }
    expect(await owner.distributionAccessToken.count({ where: { clientId: oauth.clientId } })).toBe(0)
  })

  it('DA-05 GET /me answers inside the envelope for a bearer token and for an API key', async () => {
    const clientId = await client()
    const oauth = await credential(clientId, 'OAUTH_CLIENT')
    const apiKey = await credential(clientId, 'API_KEY')
    const token = (await issue(oauth, 'search book').expect(200)).body.access_token
    const viaToken = await http().get('/api/v1/distribution/v1/me').set('Authorization', `Bearer ${token}`).expect(200)
    expect(viaToken.body).toEqual({ success: true, data: { clientId, agencyId, authenticatedWith: 'access_token', scopes: ['search', 'book'], limits: { searchPerMinute: 120, checkRatePerMinute: 30, bookPerMinute: 10 } } })
    const viaKey = await http().get('/api/v1/distribution/v1/me').set('Authorization', `ApiKey ${apiKey.apiKey}`).expect(200)
    expect(viaKey.body.data).toEqual(expect.objectContaining({ clientId, authenticatedWith: 'api_key', scopes: ['search', 'checkrate', 'book'] }))
  })

  it('DA-06 every invalid credential is the same 401; an OAuth secret is not an API key; a session cookie is not a partner credential', async () => {
    const clientId = await client()
    const oauth = await credential(clientId, 'OAUTH_CLIENT')
    const bad = [undefined, 'Bearer fbt_' + 'a'.repeat(43), `ApiKey ${newCredentialMaterial().apiKey}`, `ApiKey ${oauth.apiKey}`, `ApiKey ${oauth.apiKey.slice(0, -1)}`, 'Basic Zm9vOmJhcg==']
    const answers = new Set<string>()
    for (const authorization of bad) {
      const req = http().get('/api/v1/distribution/v1/me')
      const res = await (authorization ? req.set('Authorization', authorization) : req).expect(401)
      expect(res.headers['www-authenticate']).toMatch(/^Bearer realm="fbeds-distribution"/)
      answers.add(JSON.stringify(res.body.error))
    }
    expect(answers.size).toBe(1)
    expect(sessionCookie).not.toBe('')
    await http().get('/api/v1/distribution/v1/me').set('Cookie', sessionCookie).expect(401)
  })

  it('DA-07 revocation and suspension take effect on the next request', async () => {
    const clientId = await client()
    const oauth = await credential(clientId, 'OAUTH_CLIENT')
    const apiKey = await credential(clientId, 'API_KEY')
    const token = (await issue(oauth).expect(200)).body.access_token
    const me = (authorization: string) => http().get('/api/v1/distribution/v1/me').set('Authorization', authorization)
    await me(`Bearer ${token}`).expect(200)
    await owner.distributionCredential.update({ where: { id: oauth.id }, data: { revokedAt: new Date() } })
    await me(`Bearer ${token}`).expect(401)
    await me(`ApiKey ${apiKey.apiKey}`).expect(200)
    await owner.agency.update({ where: { id: agencyId }, data: { status: 'SUSPENDED' } })
    try {
      await me(`ApiKey ${apiKey.apiKey}`).expect(401)
    } finally {
      await owner.agency.update({ where: { id: agencyId }, data: { status: 'ACTIVE' } })
    }
    await me(`ApiKey ${apiKey.apiKey}`).expect(200)
  })

  it('DA-08 the CIDR allowlist is enforced on the connection address', async () => {
    const outside = await credential(await client({ ipAllowlist: ['203.0.113.0/24'] }), 'API_KEY')
    await http().get('/api/v1/distribution/v1/me').set('Authorization', `ApiKey ${outside.apiKey}`).expect(401)
    const local = await credential(await client({ ipAllowlist: ['127.0.0.0/8', '::1/128'] }), 'API_KEY')
    await http().get('/api/v1/distribution/v1/me').set('Authorization', `ApiKey ${local.apiKey}`).expect(200)
  })
})
