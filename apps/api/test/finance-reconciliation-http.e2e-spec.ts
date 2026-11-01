import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { routes, STEP_UP_FIELD } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { configureJsonBodyLimits } from '../src/finance-reconciliation/body-limit'
import { ReconciliationRunner } from '../src/finance-reconciliation/reconciliation-runner.service'

/** ADR 0070 over HTTP: authentication, the three separate permissions, tenant isolation and separation of duties on the real controllers and guards. */
describe('finance reconciliation HTTP authorization (ADR 0070)', () => {
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'recon-http-certification-password'
  const r = routes.adminFinanceReconciliation
  const email = (name: string) => `${name}-${suffix}@example.test`
  const people = ['viewer', 'importer', 'resolver1', 'resolver2', 'nobody'] as const
  const grants: Record<(typeof people)[number], string[]> = {
    viewer: ['finance.read'], importer: ['finance.read', 'finance.reconcile.run'], resolver1: ['finance.read', 'finance.reconcile.resolve'], resolver2: ['finance.read', 'finance.reconcile.resolve'], nobody: [],
  }
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let supplierId: string
  let foreignStatementId: string
  let foreignExceptionId: string
  const roleIds: string[] = []
  const userIds: string[] = []

  beforeAll(async () => {
    process.env.FINANCE_RECONCILIATION_ENABLED = 'true'
    tenantId = (await prisma.tenant.create({ data: { name: 'Recon HTTP', slug: `recon-http-${suffix}` } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Recon HTTP other', slug: `recon-http-other-${suffix}` } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'DMC', legalName: `Recon ${suffix} LLC`, displayName: 'Recon Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const foreignSupplier = (await prisma.supplier.create({ data: { tenantId: otherTenantId, type: 'DMC', legalName: `Foreign ${suffix} LLC`, displayName: 'Foreign Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const passwordHash = await hashPassword(password)
    for (const name of people) {
      const user = await prisma.user.create({ data: { email: email(name), passwordHash } })
      userIds.push(user.id)
      await prisma.membership.create({ data: { tenantId, userId: user.id, role: 'member' } })
      if (grants[name].length) {
        const role = await prisma.role.create({ data: { tenantId, name: `${name}-${suffix}` } })
        roleIds.push(role.id)
        for (const key of grants[name]) {
          const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
          await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
        }
        await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, tenantId } })
      }
    }
    await prisma.booking.create({ data: { tenantId, supplierId, reference: `HTTP-${suffix}`, supplier: 'S', hotelId: 'h1', status: 'CONFIRMED', currency: 'AED', totalMinor: 90000n, idempotencyKey: `http-${suffix}`, searchSnapshot: {}, netMinor: 10000n, checkOut: new Date('2026-10-10T00:00:00Z') } as never })
    // A statement and an exception that belong to ANOTHER tenant: no user of the first tenant may see or decide them.
    const foreign = await prisma.supplierStatement.create({ data: { tenantId: otherTenantId, supplierId: foreignSupplier, statementRef: `F-${suffix}`, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), lineCount: 1, contentSha256: 'f'.repeat(64), requestId: `foreign-${suffix}`, importedById: userIds[0] } })
    foreignStatementId = foreign.id
    const run = await prisma.reconciliationRun.create({ data: { tenantId: otherTenantId, statementId: foreign.id, requestId: `foreign-run-${suffix}`, requestedById: userIds[0] } })
    foreignExceptionId = (await prisma.reconciliationFinding.create({ data: { tenantId: otherTenantId, statementId: foreign.id, supplierId: foreignSupplier, findingKey: 'k', type: 'UNMATCHED_LINE', rule: 'NONE', isException: true, currency: 'AED', lastRunId: run.id } })).id

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    configureJsonBodyLimits(app, 'api/v1')
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    // Listen up front: supertest 7.3 closes a server it started once no request is pending, which races requests built around an awaited login.
    await app.listen(0, '127.0.0.1')
  }, 60000)

  afterAll(async () => {
    await app?.close()
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const table of ['ReconciliationDecision', 'ReconciliationFinding', 'ReconciliationRun', 'SupplierStatementLine', 'SupplierStatement', 'Booking', 'AuditEvent', 'UserRole', 'Role', 'memberships', 'Supplier']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = ANY($1)`, [tenantId, otherTenantId])
      }
    })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  const cookies = new Map<string, string>()
  async function login(name: (typeof people)[number]): Promise<string> {
    const cached = cookies.get(name)
    if (cached) return cached
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email: email(name), password }).expect(200)
    const cookie = response.headers['set-cookie'][0].split(';')[0]
    cookies.set(name, cookie)
    return cookie
  }
  const api = (path: string) => `/api/v1${path}`
  const get = async (name: (typeof people)[number], path: string) => request(app.getHttpServer()).get(api(path)).set('Cookie', await login(name))
  const post = async (name: (typeof people)[number], path: string, body: unknown = {}) => request(app.getHttpServer()).post(api(path)).set('Cookie', await login(name)).send(body as object)
  const body = (over: Record<string, unknown> = {}) => ({ supplierId, statementRef: `H-${suffix}-${Math.random().toString(36).slice(2, 6)}`, periodStart: '2026-10-01', periodEnd: '2026-10-31', requestId: `http-${Math.random().toString(36).slice(2, 12)}`, lines: [{ reference: `HTTP-${suffix}`, kind: 'CHARGE', currency: 'AED', amount: '350.00' }], ...over })

  it('HTTP-AUTHN: every route answers 401 without a session', async () => {
    const paths: Array<['get' | 'post', string]> = [['get', r.statements], ['get', r.statement.replace(':statementId', 'x')], ['post', r.statements], ['post', r.run.replace(':statementId', 'x')], ['get', r.exceptions], ['get', r.exceptionSummary],
      ['get', r.exception.replace(':exceptionId', 'x')], ['post', r.propose.replace(':exceptionId', 'x')], ['post', r.approve.replace(':exceptionId', 'x')], ['post', r.reject.replace(':exceptionId', 'x')]]
    for (const [method, path] of paths) await request(app.getHttpServer())[method](api(path)).expect(401)
  })

  it('HTTP-AUTHZ: reads need finance.read; importing needs finance.reconcile.run; deciding needs finance.reconcile.resolve; none implies another', async () => {
    await get('nobody', r.statements).then((res) => expect(res.status).toBe(403))
    await get('nobody', r.exceptions).then((res) => expect(res.status).toBe(403))
    await get('viewer', r.statements).then((res) => expect(res.status).toBe(200))
    await get('viewer', r.exceptionSummary).then((res) => expect(res.status).toBe(200))
    await post('viewer', r.statements, body()).then((res) => expect(res.status).toBe(403))
    await post('viewer', r.propose.replace(':exceptionId', 'x'), { action: 'ACKNOWLEDGE', reason: 'no permission' }).then((res) => expect(res.status).toBe(403))
    await post('resolver1', r.statements, body()).then((res) => expect(res.status).toBe(403))
    await post('importer', r.propose.replace(':exceptionId', 'x'), { action: 'ACKNOWLEDGE', reason: 'importer cannot decide' }).then((res) => expect(res.status).toBe(403))
    expect(await prisma.supplierStatement.count({ where: { tenantId } })).toBe(0)
  })

  it('HTTP-TENANT: another tenant\'s statement and exception are invisible and untouchable, even with the right permissions', async () => {
    await get('viewer', r.statement.replace(':statementId', foreignStatementId)).then((res) => expect(res.status).toBe(404))
    await get('viewer', r.exception.replace(':exceptionId', foreignExceptionId)).then((res) => expect(res.status).toBe(404))
    await post('resolver1', r.propose.replace(':exceptionId', foreignExceptionId), { action: 'ACKNOWLEDGE', reason: 'cross tenant attempt' }).then((res) => expect(res.status).toBe(404))
    await post('importer', r.run.replace(':statementId', foreignStatementId), { requestId: `cross-${suffix}-1` }).then((res) => expect(res.status).toBe(404))
    const list = await get('viewer', r.statements)
    expect(list.body.data.total).toBe(0)
    // A body cannot choose the tenant: a supplier of the other tenant is simply not found.
    const foreignSupplier = (await prisma.supplier.findFirst({ where: { tenantId: otherTenantId } }))!.id
    await post('importer', r.statements, body({ supplierId: foreignSupplier })).then((res) => expect(res.status).toBe(404))
  })

  it('HTTP-FLOW: import, match, propose and a different person approves; the proposer is refused; the envelope carries minor units as strings', async () => {
    const imported = await post('importer', r.statements, body())
    expect(imported.status).toBe(200)
    const statementId = imported.body.data.id as string
    const run = await post('importer', r.run.replace(':statementId', statementId), { requestId: `http-run-${suffix}` })
    expect(run.status).toBe(200)
    expect(run.body.data).toMatchObject({ status: 'QUEUED', roundingToleranceMinor: '0' })
    expect(await app.get(ReconciliationRunner).drain(tenantId)).toBeGreaterThanOrEqual(1)

    const queue = await get('viewer', `${r.exceptions}?statementId=${statementId}`)
    expect(queue.status).toBe(200)
    const [exception] = queue.body.data.items
    expect(exception).toMatchObject({ type: 'AMOUNT_OVERCHARGE', severity: 'HIGH', status: 'OPEN', statementMinor: '35000', ledgerMinor: '10000', varianceMinor: '25000', canPropose: true, canDecide: false })

    const proposed = await post('resolver1', r.propose.replace(':exceptionId', exception.id), { action: 'ACCEPT_STATEMENT', reason: 'Supplier rate card changed' })
    expect(proposed.status).toBe(200)
    expect(proposed.body.data.exception).toMatchObject({ status: 'PENDING_APPROVAL', proposedById: userIds[2], canDecide: false })
    const self = await post('resolver1', r.approve.replace(':exceptionId', exception.id), { reason: 'approving my own proposal', [STEP_UP_FIELD]: password })
    expect(self.status).toBe(403)
    expect(self.body.error.code ?? self.body.error.message).toBeDefined()
    const noReason = await post('resolver2', r.approve.replace(':exceptionId', exception.id), { [STEP_UP_FIELD]: password })
    expect(noReason.status).toBe(400)
    const approved = await post('resolver2', r.approve.replace(':exceptionId', exception.id), { reason: 'Verified the rate card', [STEP_UP_FIELD]: password })
    expect(approved.status).toBe(200)
    expect(approved.body.data.exception).toMatchObject({ status: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', resolvedById: userIds[3] })
    const history = approved.body.data.history.map((h: { action: string; toStatus: string }) => `${h.action}:${h.toStatus}`)
    expect(history).toEqual(['ACCEPT_STATEMENT:PENDING_APPROVAL', 'APPROVED:RESOLVED'])
    expect(await prisma.ledgerEntry.count({ where: { tenantId } })).toBe(0)
  })

  it('HTTP-SCALE: a 5,000-line statement (about 400 KB) imports over HTTP and matches within the run, while another route still enforces the default body limit', async () => {
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'DMC', legalName: `Scale ${suffix} LLC`, displayName: 'Scale Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })
    const count = 5000
    await prisma.booking.createMany({ data: Array.from({ length: count }, (_, i) => ({ tenantId, supplierId: supplier.id, reference: `SC-${suffix}-${i}`, supplier: 'S', hotelId: 'h1', status: 'CONFIRMED' as const, currency: 'AED', totalMinor: 20000n, idempotencyKey: `sc-${suffix}-${i}`, searchSnapshot: {}, netMinor: BigInt(10000 + (i % 7)), checkOut: new Date('2026-10-10T00:00:00Z') })) })
    const lines = Array.from({ length: count }, (_, i) => ({ reference: `sc-${suffix}-${i}`.toUpperCase(), kind: 'CHARGE', currency: 'AED', amount: `${100 + Math.floor((i % 7) / 100)}.${String(i % 7).padStart(2, '0')}` }))
    const payload = body({ supplierId: supplier.id, lines })
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(300_000)
    const started = Date.now()
    const imported = await post('importer', r.statements, payload)
    expect(imported.status).toBe(200)
    const statementId = imported.body.data.id as string
    await post('importer', r.run.replace(':statementId', statementId), { requestId: `scale-run-${suffix}` }).then((res) => expect(res.status).toBe(200))
    await app.get(ReconciliationRunner).drain(tenantId)
    const detail = await get('viewer', r.statement.replace(':statementId', statementId))
    expect(detail.body.data.statement.latestRun).toMatchObject({ status: 'SUCCEEDED', matched: count, exceptions: 0 })
    expect(Date.now() - started).toBeLessThan(60_000)
    // A route outside the statement routes keeps Express's default 100 KB limit. The body is refused by the parser before any handler runs (the repo's global
    // exception filter reports a parser error as 500 rather than 413; that is existing behaviour and is not changed here).
    const oversized = await post('resolver1', r.propose.replace(':exceptionId', 'x'), { action: 'ACKNOWLEDGE', reason: 'x'.repeat(200_000) })
    expect(oversized.status).toBeGreaterThanOrEqual(400)
    expect(await prisma.reconciliationDecision.count({ where: { tenantId, action: 'ACKNOWLEDGE' } })).toBe(0)
  }, 120000)

  it('HTTP-VALIDATION: malformed queries and bodies are 400, never 500', async () => {
    await get('viewer', `${r.exceptions}?status=NOPE`).then((res) => expect(res.status).toBe(400))
    await get('viewer', `${r.exceptions}?type=MATCHED`).then((res) => expect(res.status).toBe(400))
    await get('viewer', `${r.exceptions}?pageSize=1000`).then((res) => expect(res.status).toBe(400))
    await get('viewer', `${r.statements}?supplierId=%25%25`).then((res) => expect(res.status).toBe(400))
    await post('importer', r.statements, body({ lines: [{ reference: 'X', kind: 'CHARGE', currency: 'AED', amount: 12.5 }] })).then((res) => expect(res.status).toBe(400))
    await post('importer', r.statements, body({ lines: [] })).then((res) => expect(res.status).toBe(400))
  })
})
