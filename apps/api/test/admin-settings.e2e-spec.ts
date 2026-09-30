import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

describe('Admin settings HTTP', () => {
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'settings-certification-password'
  const ownerEmail = `settings-owner-${suffix}@example.test`
  const otherOwnerEmail = `settings-other-${suffix}@example.test`
  const deniedEmail = `settings-denied-${suffix}@example.test`
  const emails = [ownerEmail, otherOwnerEmail, deniedEmail]
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let deniedUserId: string

  const payload = {
    name: 'Settings Tenant A', supportEmail: 'ops@tenant-a.test', defaultLanguage: 'en', timeZone: 'Asia/Dubai', defaultCurrency: 'AED',
    lowBalanceThreshold: { amountMinor: '150000', currency: 'AED' },
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: 'Settings A', slug: `settings-a-${suffix}` } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Settings B', slug: `settings-b-${suffix}` } })).id
    const passwordHash = await hashPassword(password)
    const [owner, otherOwner, denied] = await Promise.all(emails.map((email) => prisma.user.create({ data: { email, passwordHash } })))
    deniedUserId = denied.id
    await prisma.membership.createMany({ data: [
      { tenantId, userId: owner.id, role: 'owner' },
      { tenantId, userId: denied.id, role: 'member' },
      { tenantId: otherTenantId, userId: otherOwner.id, role: 'owner' },
    ] })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
  }, 30000)

  afterAll(async () => {
    await app?.close()
    await prisma.tenantSettings.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.membership.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.auditEvent.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
    await prisma.session.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } })
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  it('returns 401 without a session', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/settings').expect(401)
    await request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Idempotency-Key', 'key-unauthenticated').send(payload).expect(401)
  })

  it('denies members without settings.manage and audits the denial', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie', await login(deniedEmail)).expect(403)
    const denial = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'permission.denied', userId: deniedUserId }, orderBy: { createdAt: 'desc' } })
    expect(denial).toMatchObject({ entityType: 'admin_permission', entityId: 'settings.manage' })
  })

  it('lazily creates defaults for the authenticated tenant', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie', await login(ownerEmail)).expect(200)
    expect(response.body.data).toMatchObject({
      tenantId, slug: `settings-a-${suffix}`, defaultLanguage: 'en', timeZone: 'UTC', defaultCurrency: 'USD',
      lowBalanceThreshold: { amountMinor: '0', currency: 'USD' }, supportEmail: null,
    })
  })

  it('updates, audits and replays idempotently', async () => {
    const cookie = await login(ownerEmail)
    const key = `settings-${suffix}`
    const first = await request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie', cookie).set('Idempotency-Key', key).send(payload).expect(200)
    expect(first.body.data).toMatchObject({ name: 'Settings Tenant A', timeZone: 'Asia/Dubai', lowBalanceThreshold: { amountMinor: '150000', currency: 'AED' } })
    await request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie', cookie).set('Idempotency-Key', key).send(payload).expect(200)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'settings.updated' } })).toBe(1)
    await request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie', cookie).set('Idempotency-Key', key).send({ ...payload, timeZone: 'UTC' }).expect(409)
    await request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie', cookie).send(payload).expect(400)
  })

  it('rejects tenant selection, floats and unsupported values', async () => {
    const cookie = await login(ownerEmail)
    const patch = (body: object, key: string) => request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie', cookie).set('Idempotency-Key', key).send(body)
    await patch({ ...payload, tenantId: otherTenantId }, `tenant-${suffix}`).expect(400)
    await patch({ ...payload, lowBalanceThreshold: { amountMinor: '1500.50', currency: 'AED' } }, `float-${suffix}`).expect(400)
    await patch({ ...payload, lowBalanceThreshold: { amountMinor: 150000, currency: 'AED' } }, `number-${suffix}`).expect(400)
    await patch({ ...payload, defaultCurrency: 'usd' }, `currency-${suffix}`).expect(400)
    await patch({ ...payload, timeZone: 'Mars/Base' }, `zone-${suffix}`).expect(400)
    await request(app.getHttpServer()).get(`/api/v1/admin/settings?tenantId=${otherTenantId}`).set('Cookie', cookie).expect(400)
  })

  it('keeps tenants isolated', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie', await login(otherOwnerEmail)).expect(200)
    expect(response.body.data.tenantId).toBe(otherTenantId)
    expect(JSON.stringify(response.body.data)).not.toContain('ops@tenant-a.test')
    expect(response.body.data.lowBalanceThreshold).toEqual({ amountMinor: '0', currency: 'USD' })
  })
})
