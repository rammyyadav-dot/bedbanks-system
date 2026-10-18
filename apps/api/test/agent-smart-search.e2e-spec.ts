import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { businessDate } from '@bedbanks/domain'
import type { SmartSearchParseResponse } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'

jest.setTimeout(180_000)

/**
 * ADR 0065 over HTTP, against the real AppModule and PostgreSQL as the NON-owner, NON-BYPASSRLS API runtime role:
 * the typo-tolerant destinations typeahead (pg_trgm) and Smart Search. Data is created through the owner connection.
 */
describe('agent destinations typeahead and Smart Search (PostgreSQL, HTTP, runtime role)', () => {
  const owner = new PrismaClient()
  const suffix = `ss-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'smart-search-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = ''
  const userIds: string[] = []; const cookies: Record<string, string> = {}

  async function user(label: string, tenantId: string, keys: string[]) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
  }
  const hotel = (tenantId: string, name: string, city: string, countryCode: string, contentStatus = 'COMPLETE') => owner.hotel.create({ data: {
    tenantId, name, city, countryCode, externalRef: `${name.slice(0, 8)}-${randomBytes(4).toString('hex')}`, propertyType: 'HOTEL', address: '1 Test Road',
    latitude: '25.2', longitude: '55.27', timeZone: 'Asia/Dubai', contentStatus: contentStatus as never, starRating: 5,
  } })
  const typeahead = (q: string, who = 'agent') => { const r = request(app.getHttpServer()).get(`/api/v1/agent/destinations?q=${encodeURIComponent(q)}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const names = async (q: string) => ((await typeahead(q).expect(200)).body.data.results as Array<{ type: string; name: string }>).map((r) => `${r.type}:${r.name}`)
  const parse = (text: unknown, who = 'agent') => { const r = request(app.getHttpServer()).post('/api/v1/agent/search/parse'); return (who === 'anon' ? r : r.set('Cookie', cookies[who])).send({ text }) }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    await hotel(tenantA, 'Grand Palm Resort', 'Dubai', 'AE')
    await hotel(tenantA, 'Marina Bay Suites', 'Dubai', 'AE')
    await hotel(tenantA, 'Gateway Residency', 'Mumbai', 'IN')
    await hotel(tenantA, 'Unpublished Draft Dubai', 'Dubai', 'AE', 'DRAFT')
    await hotel(tenantB, 'Other Tenant Secret Hotel', 'Dubai', 'AE')
    await user('agent', tenantA, ['hotel.search']); await user('none', tenantA, [])

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['agent', 'none']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`, `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`,
        `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM "memberships" WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('SS-E01: the typeahead tolerates typos, rewrites aliases, and returns only this tenant’s published catalogue', async () => {
    expect(await names('Dubai')).toEqual(expect.arrayContaining(['city:Dubai']))
    expect(await names('Dubia')).toContain('city:Dubai')
    expect(await names('Grnd Palm')).toContain('hotel:Grand Palm Resort')
    expect(await names('marina bay')).toContain('hotel:Marina Bay Suites')
    expect(await names('دبي')).toContain('city:Dubai')
    expect(await names('Bombay')).toContain('city:Mumbai')
    const all = [...await names('Dubai'), ...await names('hotel'), ...await names('secret')]
    expect(all.join('|')).not.toMatch(/Unpublished Draft|Other Tenant Secret/)
    expect(await names('x')).toEqual([])
    expect(await names('Zanzibar Lighthouse')).toEqual([])
  })

  it('SS-E02: Smart Search reads the brief example and resolves the destination against the catalogue', async () => {
    const r = (await parse('5-star hotel in Dubai near Marina for 2 adults 3 nights from next Friday').expect(201)).body.data as SmartSearchParseResponse
    const today = businessDate(new Date())
    expect(r.today).toBe(today)
    expect(r.destination).toMatchObject({ type: 'city', name: 'Dubai', countryCode: 'AE' })
    expect(r.starRatings).toEqual([5])
    expect(r.rooms).toEqual([{ adults: 2, childAges: [] }])
    expect(r.nights).toBe(3)
    expect(new Date(`${r.checkIn}T00:00:00Z`).getUTCDay()).toBe(5)
    expect(r.checkIn! > today).toBe(true)
    expect(r.unresolved).toEqual(['nationality'])
    expect(r.notes.join(' ')).toMatch(/near Marina/)
  })

  it('SS-E03: an unknown place is reported, not guessed; a pasted email with children and nationality is read', async () => {
    const unknown = (await parse('Zanzibar for 2 adults, 2 nights from tomorrow, at Zanzibar Lighthouse').expect(201)).body.data as SmartSearchParseResponse
    expect(unknown.destination).toBeUndefined()
    expect(unknown.unresolved).toContain('destination')
    expect(unknown.notes.join(' ')).toMatch(/not a city or hotel in your catalogue/)
    const email = (await parse('Dear team, please quote 2 rooms in Bombay for 4 adults and 2 kids aged 6 and 11, Indian guests, 2 nights from tomorrow.').expect(201)).body.data as SmartSearchParseResponse
    expect(email.destination).toMatchObject({ type: 'city', name: 'Mumbai' })
    expect(email.rooms).toEqual([{ adults: 2, childAges: [6] }, { adults: 2, childAges: [11] }])
    expect(email.nationality).toBe('IN')
  })

  it('SS-E04: validation and access: bounded text, authentication and the hotel.search permission', async () => {
    await parse('', 'agent').expect(400)
    await parse('x'.repeat(2001), 'agent').expect(400)
    await parse(42, 'agent').expect(400)
    await parse('Dubai 2 adults', 'anon').expect(401)
    await parse('Dubai 2 adults', 'none').expect(403)
    await typeahead('Dubai', 'none').expect(403)
    await typeahead('Dubai', 'anon').expect(401)
  })

  it('SS-E05: the pasted text is not written anywhere (no audit event carries it)', async () => {
    const marker = `Mr Confidential ${randomBytes(4).toString('hex')}`
    await parse(`Guest ${marker}, 2 adults in Dubai tomorrow for 1 night`).expect(201)
    const events = await owner.auditEvent.findMany({ where: { tenantId: tenantA } })
    expect(JSON.stringify(events)).not.toContain(marker)
  })
})
