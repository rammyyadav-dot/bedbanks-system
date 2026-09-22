import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

describe('Platform admin access foundation', () => {
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'platform-certification-password'
  const operatorEmail = `platform-${suffix}@example.test`
  const tenantOwnerEmail = `tenant-owner-${suffix}@example.test`
  let app: INestApplication
  let operatorId: string
  let ownerId: string
  let tenantAId: string
  let tenantBId: string
  let roleId: string
  let assignment: { userId: string; roleId: string }

  beforeAll(async () => {
    await prisma.$connect()
    const [tenantA, tenantB] = await Promise.all([
      prisma.tenant.create({ data: { name: `Platform Tenant A ${suffix}`, slug: `platform-a-${suffix}` } }),
      prisma.tenant.create({ data: { name: `Platform Tenant B ${suffix}`, slug: `platform-b-${suffix}` } }),
    ])
    tenantAId = tenantA.id
    tenantBId = tenantB.id
    const passwordHash = await hashPassword(password)
    const operator = await prisma.user.create({ data: { email: operatorEmail, passwordHash } })
    const owner = await prisma.user.create({ data: { email: tenantOwnerEmail, passwordHash } })
    operatorId = operator.id
    ownerId = owner.id
    await prisma.membership.create({ data: { tenantId: tenantAId, userId: owner.id, role: 'owner' } })
    const permission = await prisma.platformPermission.upsert({ where: { key: 'platform.tenants.read' }, update: {}, create: { id: 'platform-permission-tenants-read', key: 'platform.tenants.read' } })
    const accessPermission = await prisma.platformPermission.upsert({ where: { key: 'platform.tenants.access' }, update: {}, create: { id: 'platform-permission-tenants-access', key: 'platform.tenants.access' } })
    const role = await prisma.platformRole.create({ data: { id: `platform-role-${suffix}`, name: `platform-read-access-${suffix}` } })
    roleId = role.id
    await prisma.platformRolePermission.createMany({ data: [
      { roleId, permissionId: permission.id },
      { roleId, permissionId: accessPermission.id },
    ] })
    assignment = { userId: operator.id, roleId }
    await prisma.platformRoleAssignment.create({ data: assignment })

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
    await prisma.platformRoleAssignment.deleteMany({ where: { roleId } })
    await prisma.platformRolePermission.deleteMany({ where: { roleId } })
    await prisma.platformRole.deleteMany({ where: { id: roleId } })
    await prisma.auditEvent.deleteMany({ where: { userId: { in: [operatorId, ownerId] } } })
    await prisma.membership.deleteMany({ where: { userId: ownerId } })
    await prisma.user.deleteMany({ where: { id: { in: [operatorId, ownerId] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
    await prisma.$disconnect()
  })

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  it('returns 401 without a session', async () => {
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').expect(401)
  })

  it('keeps tenant owners out of the platform security plane', async () => {
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', await login(tenantOwnerEmail)).expect(403)
  })

  it('lists tenants from explicit database-backed platform permission and persists request ID audit data', async () => {
    const requestId = `platform-request-${suffix}`
    const response = await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', await login(operatorEmail)).set('x-request-id', requestId).expect(200)
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tenantAId, name: expect.stringContaining('Platform Tenant A') }),
      expect.objectContaining({ id: tenantBId, name: expect.stringContaining('Platform Tenant B') }),
    ]))
    await expect(prisma.auditEvent.findFirst({ where: { userId: operatorId, action: 'platform.tenants.directory.read', entityId: 'platform.tenants.read', payload: { path: ['requestId'], equals: requestId } } })).resolves.toMatchObject({ actorType: 'USER', entityType: 'platform_tenant_directory' })
  })

  it('rejects a revoked session on the next platform request', async () => {
    const cookie = await login(operatorEmail)
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', cookie).expect(200)
    await prisma.session.updateMany({ where: { userId: operatorId }, data: { revokedAt: new Date() } })
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', cookie).expect(401)
  })

  it('reads only the explicitly selected tenant context and rejects an unknown target', async () => {
    const cookie = await login(operatorEmail)
    const response = await request(app.getHttpServer()).get(`/api/v1/platform/tenants/${tenantAId}/summary`).set('Cookie', cookie).set('x-platform-permission', 'platform.tenants.read').expect(200)
    expect(response.body.data.tenant.id).toBe(tenantAId)
    expect(response.body.data.platformContext.targetTenantId).toBe(tenantAId)
    await request(app.getHttpServer()).get('/api/v1/platform/tenants/does-not-exist/summary').set('Cookie', cookie).expect(404)
  })

  it('ignores forged permission headers and revokes platform access immediately', async () => {
    const ownerCookie = await login(tenantOwnerEmail)
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', ownerCookie).set('x-platform-permission', 'platform.tenants.read').expect(403)
    const operatorCookie = await login(operatorEmail)
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', operatorCookie).expect(200)
    await prisma.platformRoleAssignment.delete({ where: { userId_roleId: assignment } })
    await request(app.getHttpServer()).get('/api/v1/platform/tenants').set('Cookie', operatorCookie).expect(403)
  })
})
