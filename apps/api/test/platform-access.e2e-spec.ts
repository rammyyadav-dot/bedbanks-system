import { INestApplication } from '@nestjs/common'
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
  const roleId = `e2e.role.${Date.now()}`

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api/v1')
    await app.init()
    prisma = app.get(PrismaService)
    const user = await prisma.user.create({ data: { email: operator, name: 'Platform Access E2E', passwordHash: await hashPassword(password) }, select: { id: true } })
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: operator, password })
    cookie = login.headers['set-cookie']?.[0] ?? ''
    if (!user) throw new Error('Seed operator missing')
    userId = user.id
    await prisma.platformRole.create({ data: { id: roleId, name: roleId, description: 'E2E role' } })
    await prisma.platformRolePermission.createMany({ data: [{ roleId, permissionId: 'platform.access.read' }, { roleId, permissionId: 'platform.access.manage' }] })
    await prisma.platformRoleAssignment.create({ data: { userId, roleId } })
  })

  afterAll(async () => {
    await prisma.platformRoleAssignment.deleteMany({ where: { roleId } })
    await prisma.platformRolePermission.deleteMany({ where: { roleId } })
    await prisma.platformRole.deleteMany({ where: { id: roleId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await app.close()
  })

  it('lists canonical permissions and roles from the database', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/platform/access/permissions').set('Cookie', cookie)
    expect(response.status).toBe(200)
    expect(response.body.some((permission: { key: string }) => permission.key === 'platform.access.manage')).toBe(true)
  })

  it('prevents self-escalation and audits governed changes', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/platform/access/assignments').set('Cookie', cookie).send({ userId, roleId })
    expect(response.status).toBe(400)
    const audit = await prisma.auditEvent.findFirst({ where: { userId, action: 'platform.role.assigned' }, orderBy: { createdAt: 'desc' } })
    expect(audit).toBeNull()
  })
})
