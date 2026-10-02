import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'

jest.setTimeout(120_000)

/** Maker-checker in front of a reconciliation run, over HTTP against PostgreSQL, two tenants. */
describe('reconciliation approval (maker-checker, PostgreSQL, HTTP)', () => {
  const prisma = new PrismaClient()
  const suffix = `ra-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'reconciliation-approval-password'
  let app: INestApplication
  let tenantA = '', tenantB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let seq = 0

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id); ids[label] = u.id
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of keys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const base = '/api/v1/admin/operations/reconciliation/approvals'
  const call = (method: 'get' | 'post', path: string, who: string, body?: object) => { const r = request(app.getHttpServer())[method](`${base}${path}`).set('Cookie', cookies[who]); return body ? r.send(body) : r }
  const ask = async (who = 'maker', extra: object = {}) => (await call('post', '', who, { requestId: `${suffix}-${++seq}`, reason: 'Stalled holds after supplier outage', ...extra }).expect(201)).body.data

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const maker = await user('maker', tenantA, ['booking.reconcile', 'booking.read'])
    const checker = await user('checker', tenantA, ['booking.reconcile'])
    const reader = await user('reader', tenantA, ['booking.read'])
    const bchecker = await user('bchecker', tenantB, ['booking.reconcile'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.maker = await login(maker); cookies.checker = await login(checker); cookies.reader = await login(reader); cookies.bchecker = await login(bchecker)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.approvalRequest.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  it('RA-01 happy path: request, a different person approves, it runs once with exactly the approved parameters', async () => {
    const reconcile = jest.spyOn(app.get(OperationsTransactionsService), 'reconcile')
    const a = await ask('maker', { staleMinutes: 45, prebookMaxMinutes: 90 })
    expect(a).toMatchObject({ status: 'PENDING', requestedById: ids.maker, parameters: { staleMinutes: 45, prebookMaxMinutes: 90 }, canDecide: false })
    expect(typeof a.stalledHoldsAtRequest).toBe('number')
    const seen = (await call('get', '', 'checker').expect(200)).body.data.items.find((x: { id: string }) => x.id === a.id)
    expect(seen.canDecide).toBe(true)
    const approved = (await call('post', `/${a.id}/approve`, 'checker', { reason: 'Verified with supplier extranet' }).expect(200)).body.data
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: ids.checker, decisionReason: 'Verified with supplier extranet' })
    const run = (await call('post', `/${a.id}/execute`, 'maker', { staleMinutes: 5, prebookMaxMinutes: 15 }).expect(200)).body.data // a body here must be ignored
    expect(run.approval).toMatchObject({ status: 'EXECUTED', executedById: ids.maker })
    expect(run.result).toMatchObject({ dryRun: false, examined: expect.any(Number) })
    expect(reconcile).toHaveBeenCalledWith(tenantA, ids.maker, expect.stringContaining(`approval:${a.id}`), { staleMinutes: 45, prebookMaxMinutes: 90 })
    const actions = (await prisma.auditEvent.findMany({ where: { entityType: 'approval_request', entityId: a.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.action)
    expect(actions).toEqual(['approval.requested', 'approval.approved', 'approval.executed'])
    reconcile.mockRestore()
  })

  it('RA-02 single use: an executed approval cannot run again, concurrent executes run exactly once', async () => {
    const reconcile = jest.spyOn(app.get(OperationsTransactionsService), 'reconcile')
    const a = await ask(); await call('post', `/${a.id}/approve`, 'checker', { reason: 'ok' }).expect(200)
    const results = await Promise.all([call('post', `/${a.id}/execute`, 'maker'), call('post', `/${a.id}/execute`, 'checker')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    await call('post', `/${a.id}/execute`, 'maker').expect(409)
    expect(reconcile).toHaveBeenCalledTimes(1)
    reconcile.mockRestore()
  })

  it('RA-03 separation of duties: the requester cannot approve or reject their own request, and nothing runs without approval', async () => {
    const reconcile = jest.spyOn(app.get(OperationsTransactionsService), 'reconcile')
    const a = await ask()
    await call('post', `/${a.id}/approve`, 'maker', { reason: 'me' }).expect(403)
    await call('post', `/${a.id}/reject`, 'maker', { reason: 'me' }).expect(403)
    await call('post', `/${a.id}/execute`, 'maker').expect(409) // still pending
    expect(reconcile).not.toHaveBeenCalled()
    expect((await prisma.auditEvent.findMany({ where: { entityId: a.id, action: 'approval.denied' } })).length).toBe(2)
    reconcile.mockRestore()
  })

  it('RA-04 rejected and cancelled requests can never run; only the requester can cancel', async () => {
    const reconcile = jest.spyOn(app.get(OperationsTransactionsService), 'reconcile')
    const r = await ask(); await call('post', `/${r.id}/reject`, 'checker', { reason: 'not needed' }).expect(200)
    await call('post', `/${r.id}/execute`, 'maker').expect(409)
    const c = await ask(); await call('post', `/${c.id}/cancel`, 'checker').expect(403)
    expect((await call('post', `/${c.id}/cancel`, 'maker').expect(200)).body.data.status).toBe('CANCELLED')
    await call('post', `/${c.id}/approve`, 'checker', { reason: 'late' }).expect(409)
    await call('post', `/${c.id}/execute`, 'maker').expect(409)
    expect(reconcile).not.toHaveBeenCalled()
    reconcile.mockRestore()
  })

  it('RA-05 a failed run releases the approval for a retry and records the failure', async () => {
    const reconcile = jest.spyOn(app.get(OperationsTransactionsService), 'reconcile').mockRejectedValueOnce(new Error('supplier down'))
    const a = await ask(); await call('post', `/${a.id}/approve`, 'checker', { reason: 'ok' }).expect(200)
    await call('post', `/${a.id}/execute`, 'maker').expect(500)
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('APPROVED')
    expect((await prisma.auditEvent.findMany({ where: { entityId: a.id, action: 'approval.execution_failed' } })).length).toBe(1)
    await call('post', `/${a.id}/execute`, 'maker').expect(200) // second attempt succeeds and consumes it
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('EXECUTED')
    reconcile.mockRestore()
  })

  it('RA-06 idempotent request, validation and no tenant from the client', async () => {
    const body = { requestId: `${suffix}-idem`, reason: 'same request twice' }
    const first = (await call('post', '', 'maker', body).expect(201)).body.data
    expect((await call('post', '', 'maker', body).expect(201)).body.data.id).toBe(first.id)
    expect(await prisma.approvalRequest.count({ where: { tenantId: tenantA, requestId: body.requestId } })).toBe(1)
    await call('post', '', 'checker', body).expect(409) // another user reusing the key
    await call('post', '', 'maker', { reason: 'x' }).expect(400) // requestId missing
    await call('post', '', 'maker', { requestId: `${suffix}-r`, reason: '   ' }).expect(400)
    await call('post', '', 'maker', { requestId: `${suffix}-r2`, reason: 'x', staleMinutes: 0 }).expect(400)
    await call('post', '', 'maker', { requestId: `${suffix}-r3`, reason: 'x', prebookMaxMinutes: 14 }).expect(400)
    const t = (await call('post', '', 'maker', { requestId: `${suffix}-t`, reason: 'tenant from body', tenantId: tenantB })).status
    expect([201, 400]).toContain(t)
    expect(await prisma.approvalRequest.count({ where: { tenantId: tenantB } })).toBe(0)
  })

  it('RA-07 RBAC and tenant isolation: booking.reconcile is required for every step; tenant B cannot see or act on tenant A approvals', async () => {
    const a = await ask()
    await call('get', '', 'reader').expect(403)
    await call('post', '', 'reader', { requestId: `${suffix}-x`, reason: 'x' }).expect(403)
    await call('post', `/${a.id}/approve`, 'reader', { reason: 'x' }).expect(403)
    await request(app.getHttpServer()).get(base).expect(401)
    expect((await call('get', '', 'bchecker').expect(200)).body.data.items.map((x: { id: string }) => x.id)).not.toContain(a.id)
    await call('post', `/${a.id}/approve`, 'bchecker', { reason: 'cross tenant' }).expect(404)
    await call('post', `/${a.id}/execute`, 'bchecker').expect(404)
  })

  it('RA-08 only reconciliation approvals are reachable through these routes', async () => {
    const other = await prisma.approvalRequest.create({ data: { tenantId: tenantA, action: 'refund.approve', entityType: 'refund', entityId: 'r-1', requestId: `${suffix}-other`, requestedById: ids.maker, reason: 'not a reconciliation' } })
    await call('post', `/${other.id}/approve`, 'checker', { reason: 'x' }).expect(400)
    await call('post', `/${other.id}/execute`, 'checker').expect(400)
  })

  it('RA-09 the database refuses an executed approval that lacks its decider or executor', async () => {
    const a = await ask(); const bad = await ask()
    await expect(prisma.$executeRaw`UPDATE "ApprovalRequest" SET status = 'EXECUTED', executed_at = now() WHERE id = ${bad.id}`).rejects.toThrow(/decision_complete/)
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('PENDING')
  })
})
