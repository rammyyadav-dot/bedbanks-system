import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

describe('Admin dashboard HTTP authorization', () => {
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'rbac-certification-password'
  const tenantSlug = `rbac-http-${suffix}`
  const ownerEmail = `owner-${suffix}@example.test`
  const allowedEmail = `allowed-${suffix}@example.test`
  const deniedEmail = `denied-${suffix}@example.test`
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let allowedUserId: string
  let deniedUserId: string
  let roleId: string

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: 'RBAC HTTP Test', slug: tenantSlug } })
    tenantId = tenant.id
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Other RBAC Tenant', slug: `rbac-other-${suffix}` } })).id
    const passwordHash = await hashPassword(password)
    const [owner, allowed, denied] = await Promise.all([
      prisma.user.create({ data: { email: ownerEmail, passwordHash } }),
      prisma.user.create({ data: { email: allowedEmail, passwordHash } }),
      prisma.user.create({ data: { email: deniedEmail, passwordHash } }),
    ])
    allowedUserId = allowed.id
    deniedUserId = denied.id
    await prisma.membership.createMany({ data: [
      { tenantId, userId: owner.id, role: 'owner' },
      { tenantId, userId: allowed.id, role: 'member' },
      { tenantId, userId: denied.id, role: 'member' },
    ] })
    const permission = await prisma.permission.upsert({ where: { key: 'dashboard.read' }, update: {}, create: { key: 'dashboard.read', description: 'Read Admin dashboard' } })
    const role = await prisma.role.create({ data: { tenantId, name: `dashboard-reader-${suffix}` } })
    roleId = role.id
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    await prisma.userRole.create({ data: { userId: allowed.id, roleId: role.id, tenantId } })

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
    await prisma.booking.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.userRole.deleteMany({ where: { tenantId } })
    await prisma.rolePermission.deleteMany({ where: { roleId } })
    await prisma.role.deleteMany({ where: { id: roleId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.session.deleteMany({ where: { userId: { in: [allowedUserId, deniedUserId] } } })
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, allowedEmail, deniedEmail] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  it('returns 401 for an unauthenticated dashboard request', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').expect(401)
  })

  it('allows an owner and a database-assigned dashboard.read user', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', await login(ownerEmail)).expect(200)
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', await login(allowedEmail)).expect(200)
  })

  it('denies missing permission and persists a redacted denial audit event', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', await login(deniedEmail)).expect(403)
    const denial = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'permission.denied', userId: deniedUserId }, orderBy: { createdAt: 'desc' } })
    expect(denial).toMatchObject({ actorType: 'USER', entityType: 'admin_permission', entityId: 'dashboard.read' })
    expect(denial?.payload).toEqual({ permission: 'dashboard.read' })
  })

  it('validates ranges and keeps all aggregates inside the authenticated tenant', async () => {
    const cookie = await login(allowedEmail)
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)
    const data = (tenantId: string, tag: string, days: number, currency: string, amount: bigint) => ({
      tenantId, reference: `RBAC-${tag}-${suffix}`, supplier: 'fixture-supplier', hotelId: 'fixture-hotel',
      status: 'CONFIRMED' as const, currency, totalMinor: amount,
      idempotencyKey: `rbac-${tag}-${suffix}`, searchSnapshot: { hotelName: tag }, createdAt: daysAgo(days),
    })
    await prisma.booking.createMany({ data: [
      data(tenantId, 'a-usd', 1, 'USD', 10025n),
      data(tenantId, 'a-aed', 2, 'AED', 20050n),
      data(tenantId, 'a-old', 20, 'USD', 30075n),
      data(tenantId, 'a-older', 80, 'USD', 40000n),
      data(otherTenantId, 'b-secret', 1, 'USD', 900000n),
    ] })

    for (const [range, expected] of [['7d', 2], ['30d', 3], ['90d', 4]] as const) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/dashboard?range=${range}`).set('Cookie', cookie).expect(200)
      const view = response.body.data
      expect(view.range).toBe(range)
      expect(view.summary.totalBookings).toBe(expected)
      expect(view.bookingActivity.reduce((sum: number, point: { total: number }) => sum + point.total, 0)).toBe(expected)
      expect(view.recentBookings).toHaveLength(expected)
      expect(JSON.stringify(view)).not.toContain('b-secret')
      expect(new Date(view.generatedAt).getTime()).toBeGreaterThan(Date.now() - 10000)
      expect(view.summary.netRevenue).toBeNull()
      expect(view.summary.activeHotels).toBeNull()
      expect(view.summary.grossBookingValue).toBeNull() // mixed currencies: no FX source
      expect(view.revenueOverview).toEqual([])
      expect(view.alerts).toEqual([])
      expect(view.topDestinations).toEqual([])
      expect(view.topSuppliers).toEqual([])
      expect(view.systemHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Database', state: 'healthy' }),
      ]))
      expect(view.recentBookings[0].amount).toEqual(expect.objectContaining({
        amountMinor: expect.stringMatching(/^\d+$/), currency: expect.stringMatching(/^[A-Z]{3}$/),
      }))
    }
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard?range=1d').set('Cookie', cookie).expect(400)
    await request(app.getHttpServer()).get(`/api/v1/admin/dashboard?tenantId=${otherTenantId}`).set('Cookie', cookie).expect(400)
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', cookie).expect(200)
  })

  it('revokes the database permission and denies the next request', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', await login(allowedEmail)).expect(200)
    await prisma.userRole.delete({ where: { userId_roleId: { userId: allowedUserId, roleId } } })
    await request(app.getHttpServer()).get('/api/v1/admin/dashboard').set('Cookie', await login(allowedEmail)).expect(403)
  })
})
