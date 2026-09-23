import { INestApplication, ValidationPipe } from '@nestjs/common'
import * as cookieParser from 'cookie-parser'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { PrismaService } from '../src/database/prisma.service'
import { hashPassword } from '../src/auth/utils/password'

describe('Platform access management (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaService
  const operator = `platform-access-${Date.now()}@example.test`
  const password = 'platform-access-password'
  let cookie: string
  let userId: string
  let targetUserId: string
  const roleId = `e2e.role.${Date.now()}`
  const targetEmail = `platform-access-target-${Date.now()}@example.test`
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    await app.init()
    prisma = app.get(PrismaService)
    const user = await prisma.user.create({ data: { email: operator, name: 'Platform Access E2E', passwordHash: await hashPassword(password) }, select: { id: true } })
    userId = user.id
    const target = await prisma.user.create({ data: { email: targetEmail, name: 'Platform Access Target', passwordHash: await hashPassword(password) }, select: { id: true } })
    targetUserId = target.id
    await prisma.platformRole.create({ data: { id: roleId, name: `Platform Access E2E ${Date.now()}`, permissions: { create: [
        { permissionId: 'platform.access.read' },
        { permissionId: 'platform.access.manage' },
        { permissionId: 'platform.roles.read' },
        { permissionId: 'platform.roles.manage' },
        { permissionId: 'platform.assignments.read' },
        { permissionId: 'platform.assignments.manage' },
      ] } } })
    await prisma.platformRoleAssignment.create({ data: { userId, roleId } })
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email: operator, password })
    cookie = login.headers['set-cookie']?.[0]?.split(';')[0] ?? ''
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.platformRoleAssignment.deleteMany({ where: { roleId } })
    await prisma.platformRolePermission.deleteMany({ where: { roleId } })
    await prisma.platformRole.deleteMany({ where: { id: roleId } })
    await prisma.user.deleteMany({ where: { id: { in: [userId, targetUserId] } } })
    await app.close()
  })

  it('lists canonical permissions and roles from the database', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/platform/access/permissions').set('Cookie', cookie)
    expect(response.status).toBe(200)
    expect(response.body.some((permission: { key: string }) => permission.key === 'platform.access.manage')).toBe(true)
  })

  it('persists mutation audits and blocks self-escalation', async () => {
    const createdRoleId = `e2e.audit.role.${Date.now()}`
    await request(app.getHttpServer()).post('/api/v1/platform/access/roles').set('Cookie', cookie).send({ id: createdRoleId, name: 'Audit Role' }).expect(201)
    await request(app.getHttpServer()).put(`/api/v1/platform/access/roles/${createdRoleId}/permissions`).set('Cookie', cookie).send({ permissionIds: ['platform.access.read'] }).expect(200)
    await request(app.getHttpServer()).post('/api/v1/platform/access/assignments').set('Cookie', cookie).send({ userId: targetUserId, roleId: createdRoleId }).expect(201)
    await request(app.getHttpServer()).delete(`/api/v1/platform/access/assignments/${targetUserId}/${createdRoleId}`).set('Cookie', cookie).expect(200)
    const audits = await prisma.auditEvent.findMany({ where: { userId, entityId: { in: [createdRoleId, `${targetUserId}:${createdRoleId}`] } }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(['platform.role.created', 'platform.role.permissions.updated', 'platform.role.assigned', 'platform.role.revoked']))
    const response = await request(app.getHttpServer()).post('/api/v1/platform/access/assignments').set('Cookie', cookie).send({ userId, roleId })
    expect(response.status).toBe(400)
    await prisma.platformRole.delete({ where: { id: createdRoleId } })
  })
})
