import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

/**
 * SupplyPermissionGuard, driven through the real HTTP endpoint it protects (GET /supply/suppliers),
 * against the disposable PostgreSQL database: a restricted-role caller who holds the exact formal
 * permission succeeds, and every other caller on the owner/session/membership axes is denied. This
 * guard (unlike AdminRbacGuard and BookingAccessGuard) grants nothing to the 'owner' membership role
 * by itself — ADR 0019 — so owner membership without the formal permission must fail closed too.
 */
describe('supply permission guard (role-guard fixtures)', () => {
  const prisma = new PrismaClient()
  const suffix = `sup-rg-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'supply-role-guard-certification-password'
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let restrictedUserId: string
  let ownerOnlyUserId: string
  let roleId: string

  const emailFor = (who: string) => `${suffix}-${who}@example.test`

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: `${suffix} tenant`, slug: suffix } })
    tenantId = tenant.id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix} other`, slug: `${suffix}-other` } })).id
    const passwordHash = await hashPassword(password)

    const [restricted, ownerOnly, , revoked, foreignOwner] = await Promise.all([
      prisma.user.create({ data: { email: emailFor('restricted'), passwordHash } }),
      prisma.user.create({ data: { email: emailFor('owner-only'), passwordHash } }),
      prisma.user.create({ data: { email: emailFor('no-membership'), passwordHash } }),
      prisma.user.create({ data: { email: emailFor('revoked'), passwordHash } }),
      prisma.user.create({ data: { email: emailFor('foreign-owner'), passwordHash } }),
    ])
    restrictedUserId = restricted.id
    ownerOnlyUserId = ownerOnly.id

    const permission = await prisma.permission.upsert({ where: { key: 'supply.suppliers.read' }, update: {}, create: { key: 'supply.suppliers.read', description: 'Read suppliers' } })
    const role = await prisma.role.create({ data: { tenantId, name: `${suffix}-reader` } })
    roleId = role.id
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })

    await prisma.membership.createMany({ data: [
      { tenantId, userId: restricted.id, role: 'member' }, // restricted-role success: formal permission, no owner role
      { tenantId, userId: ownerOnly.id, role: 'owner' }, // owner negative: owner membership, no formal permission
      { tenantId, userId: revoked.id, role: 'member', revokedAt: new Date() }, // membership negative: revoked
      { tenantId: otherTenantId, userId: foreignOwner.id, role: 'owner' }, // membership negative: owner of a different tenant
    ] })
    await prisma.userRole.create({ data: { userId: restricted.id, roleId: role.id, tenantId } })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    await app.listen(0, '127.0.0.1')
  }, 30000)

  afterAll(async () => {
    await app?.close()
    await prisma.userRole.deleteMany({ where: { tenantId } })
    await prisma.rolePermission.deleteMany({ where: { roleId } })
    await prisma.role.deleteMany({ where: { id: roleId } })
    await prisma.membership.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.auditEvent.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.session.deleteMany({ where: { user: { email: { endsWith: `@example.test`, startsWith: suffix } } } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }

  const suppliers = (cookie: string | null, tenant: string | null) => {
    let test = request(app.getHttpServer()).get('/api/v1/supply/suppliers')
    if (cookie) test = test.set('Cookie', cookie)
    if (tenant) test = test.set('x-fbeds-tenant-id', tenant)
    return test
  }

  it('SPG-01: restricted-role success — a member with only the formal supply.suppliers.read permission is admitted', async () => {
    const cookie = await login(emailFor('restricted'))
    await suppliers(cookie, tenantId).expect(200)
  })

  it('SPG-02: owner negative — owner membership grants nothing here; without the formal permission it is denied', async () => {
    const cookie = await login(emailFor('owner-only'))
    const response = await suppliers(cookie, tenantId).expect(403)
    const denial = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'permission.denied', userId: ownerOnlyUserId }, orderBy: { createdAt: 'desc' } })
    expect(denial).toMatchObject({ entityType: 'permission', entityId: 'supply.suppliers.read' })
    expect(response.body.success).toBe(false)
  })

  it('SPG-03: session negative — no session cookie at all is rejected before any tenant or permission check', async () => {
    await suppliers(null, tenantId).expect(401)
  })

  it('SPG-03b: session negative — a cookie that does not match any live session is rejected', async () => {
    await suppliers('fbeds_session=not-a-real-session-token', tenantId).expect(401)
  })

  it('SPG-03c: session negative — a session revoked after login no longer admits the caller', async () => {
    const cookie = await login(emailFor('restricted'))
    await suppliers(cookie, tenantId).expect(200)
    await prisma.session.updateMany({ where: { userId: restrictedUserId }, data: { revokedAt: new Date() } })
    await suppliers(cookie, tenantId).expect(401)
    await prisma.session.updateMany({ where: { userId: restrictedUserId }, data: { revokedAt: null } })
  })

  it('SPG-04: membership negative — a user with no membership in any tenant cannot select one', async () => {
    const cookie = await login(emailFor('no-membership'))
    await suppliers(cookie, tenantId).expect(403)
  })

  it('SPG-04b: membership negative — a revoked membership is treated as no membership', async () => {
    const cookie = await login(emailFor('revoked'))
    await suppliers(cookie, tenantId).expect(403)
  })

  it('SPG-04c: membership negative — owner of a different tenant cannot select this tenant by header alone', async () => {
    const cookie = await login(emailFor('foreign-owner'))
    await suppliers(cookie, tenantId).expect(403)
    await suppliers(cookie, otherTenantId).expect(403) // still denied: no formal supply.suppliers.read role there either
  })

  it('SPG-05: revoking the formal role mid-session denies the very next request', async () => {
    const cookie = await login(emailFor('restricted'))
    await suppliers(cookie, tenantId).expect(200)
    await prisma.userRole.delete({ where: { userId_roleId: { userId: restrictedUserId, roleId } } })
    await suppliers(cookie, tenantId).expect(403)
    await prisma.userRole.create({ data: { userId: restrictedUserId, roleId, tenantId } })
  })
})
