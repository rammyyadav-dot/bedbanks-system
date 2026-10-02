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
import { PrismaService } from '../src/database/prisma.service'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { OperationsFinanceAuditService } from '../src/admin-operations/operations-finance-audit.service'

jest.setTimeout(120_000)

/** Finance and audit summaries over HTTP, against the real AppModule and PostgreSQL, with two tenants. Dates are relative to today (UTC). */
describe('finance and audit summaries (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `fa-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'finance-audit-summary-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const at = (offsetDays: number, hours = 12) => new Date(midnight + offsetDays * 86_400_000 + hours * 3_600_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', walletAed = '', walletUsd = '', walletEur = '', walletB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}

  async function user(label: string, tenantId: string, permissionKeys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (permissionKeys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of permissionKeys) {
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
  const get = (path: string, who = 'both') => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  let seq = 0
  const entry = (tenantId: string, walletId: string, type: 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND', amountMinor: bigint, currency: string, when: Date) =>
    prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency, reference: null, idempotencyKey: `${suffix}-${++seq}`, immutableAt: when } })
  const audit = (tenantId: string, action: string, createdAt: Date, actorType: 'USER' | 'SYSTEM' = 'USER') =>
    prisma.auditEvent.create({ data: { tenantId, actorType, action, entityType: 'test', entityId: `${suffix}-${++seq}`, payload: {}, createdAt } })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    walletAed = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'AED', creditLimit: 1_000_000n } })).id
    walletUsd = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'USD', creditLimit: 0n } })).id
    walletEur = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'EUR', creditLimit: 1_000n } })).id
    walletB = (await prisma.wallet.create({ data: { tenantId: tenantB, currency: 'AED', creditLimit: 77n } })).id
    // tenant A ledger. Signed amounts, as the finance service stores them.
    await entry(tenantA, walletAed, 'CREDIT', 500_000n, 'AED', at(-1))
    await entry(tenantA, walletAed, 'DEBIT', -120_000n, 'AED', at(0))
    await entry(tenantA, walletAed, 'HOLD', -50_000n, 'AED', at(-2))
    await entry(tenantA, walletAed, 'REFUND', 20_000n, 'AED', at(-40)) // outside the 30-day window, inside 90
    await entry(tenantA, walletUsd, 'CREDIT', 10_000n, 'USD', at(0))
    await entry(tenantA, walletEur, 'DEBIT', -5_000n, 'EUR', at(0))    // limit 1000 + (-5000) = -4000: overdrawn
    await entry(tenantB, walletB, 'CREDIT', 999_999n, 'AED', at(0))     // must never reach tenant A
    // audit events
    for (const a of ['booking.prebook.succeeded', 'booking.confirmed']) await audit(tenantA, a, at(-1))
    await audit(tenantA, 'supplier.mutation.unknown', at(0), 'SYSTEM')
    await audit(tenantA, 'approval.requested', at(0))
    await audit(tenantA, 'approval.denied', at(0))
    await audit(tenantA, 'booking.legacy', at(-40))                     // outside the 30-day window
    for (let i = 0; i < 5; i++) await audit(tenantB, 'booking.prebook.succeeded', at(0))

    const both = await user('both', tenantA, ['finance.read', 'audit.read'])
    const finance = await user('finance', tenantA, ['finance.read'])
    const auditor = await user('auditor', tenantA, ['audit.read'])
    const none = await user('none', tenantA, [])
    const bboth = await user('bboth', tenantB, ['finance.read', 'audit.read'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.both = await login(both); cookies.finance = await login(finance); cookies.auditor = await login(auditor); cookies.none = await login(none); cookies.bboth = await login(bboth)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId } })
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

  const finance = async (qs = '', who = 'both') => (await get(`/finance/summary${qs}`, who).expect(200)).body.data
  const auditSummary = async (qs = '', who = 'both') => (await get(`/audit/summary${qs}`, who).expect(200)).body.data

  it('FIN-01 wallets: per-currency balance, credit limit and available credit use the finance formula, and currencies are never added together', async () => {
    const s = await finance()
    expect(s.wallets.state).toBe('available')
    expect(s.wallets.data.total).toBe(3)
    const byCur = Object.fromEntries(s.wallets.data.currencies.map((c: { currency: string }) => [c.currency, c]))
    expect(Object.keys(byCur).sort()).toEqual(['AED', 'EUR', 'USD'])
    // all-time ledger: 500000 - 120000 - 50000 + 20000
    expect(byCur.AED).toEqual({ currency: 'AED', wallets: 1, creditLimitMinor: '1000000', balanceMinor: '350000', availableCreditMinor: '1350000', overdrawnWallets: 0 })
    expect(byCur.USD).toMatchObject({ balanceMinor: '10000', availableCreditMinor: '10000', overdrawnWallets: 0 })
    expect(byCur.EUR).toMatchObject({ balanceMinor: '-5000', availableCreditMinor: '-4000', overdrawnWallets: 1 })
    for (const c of s.wallets.data.currencies) for (const k of ['creditLimitMinor', 'balanceMinor', 'availableCreditMinor']) expect(c[k]).toMatch(/^-?\d+$/)
  })

  it('FIN-02 ledger window: only entries inside the trailing window, per currency and type, with exact integer sums', async () => {
    const s = await finance()
    expect(s.window).toMatchObject({ days: 30 })
    expect(s.ledger.state).toBe('available')
    const aed = s.ledger.data.byCurrency.find((c: { currency: string }) => c.currency === 'AED')
    expect(aed.entries).toBe(3) // the 40-day-old refund is outside
    expect(aed.netMinor).toBe('330000')
    expect(aed.byType).toEqual([
      { type: 'CREDIT', entries: 1, sumMinor: '500000' }, { type: 'DEBIT', entries: 1, sumMinor: '-120000' }, { type: 'HOLD', entries: 1, sumMinor: '-50000' },
    ])
    expect(s.ledger.data.entries).toBe(5) // AED 3 + USD 1 + EUR 1
    const wide = await finance('?days=90')
    const aed90 = wide.ledger.data.byCurrency.find((c: { currency: string }) => c.currency === 'AED')
    expect(aed90.entries).toBe(4); expect(aed90.netMinor).toBe('350000')
    expect(aed90.byType.map((t: { type: string }) => t.type)).toEqual(['CREDIT', 'DEBIT', 'HOLD', 'REFUND'])
  })

  it('FIN-03 tenant isolation: tenant B sees only its own wallet and ledger, never tenant A', async () => {
    const s = await finance('', 'bboth')
    expect(s.wallets.data.total).toBe(1)
    expect(s.wallets.data.currencies).toEqual([{ currency: 'AED', wallets: 1, creditLimitMinor: '77', balanceMinor: '999999', availableCreditMinor: '1000076', overdrawnWallets: 0 }])
    expect(s.ledger.data.entries).toBe(1)
    expect(JSON.stringify(s)).not.toContain('350000')
  })

  it('AUD-01 audit summary: counts, domains and attention signals for the window only', async () => {
    const s = await auditSummary()
    expect(s.events.state).toBe('available')
    const e = s.events.data
    expect(e.attention).toEqual({ denied: 1, unknownSupplierOutcomes: 1, selfApprovalAttempts: 1 })
    const domain = Object.fromEntries(e.byDomain.map((d: { domain: string; events: number }) => [d.domain, d.events]))
    expect(domain.booking).toBe(2) // booking.legacy is 40 days old
    expect(domain.supplier).toBe(1); expect(domain.approval).toBe(2)
    expect(e.total).toBeGreaterThanOrEqual(5) // login also records tenant.context.selected
    expect(e.byActorType.map((a: { actorType: string }) => a.actorType)).toEqual(expect.arrayContaining(['USER', 'SYSTEM']))
    expect(Date.parse(e.lastEventAt)).not.toBeNaN()
    const wide = await auditSummary('?days=90')
    expect(Object.fromEntries(wide.events.data.byDomain.map((d: { domain: string; events: number }) => [d.domain, d.events])).booking).toBe(3)
  })

  it('AUD-02 tenant isolation: tenant B counts only its own five booking events', async () => {
    const s = await auditSummary('', 'bboth')
    const domain = Object.fromEntries(s.events.data.byDomain.map((d: { domain: string; events: number }) => [d.domain, d.events]))
    expect(domain.booking).toBe(5); expect(domain.supplier).toBeUndefined(); expect(domain.approval).toBeUndefined()
    expect(s.events.data.attention).toEqual({ denied: 0, unknownSupplierOutcomes: 0, selfApprovalAttempts: 0 })
  })

  it('RBAC: finance.read gates the finance summary and audit.read gates the audit summary; neither implies the other; anonymous is refused', async () => {
    await get('/finance/summary', 'finance').expect(200)
    await get('/audit/summary', 'finance').expect(403)
    await get('/audit/summary', 'auditor').expect(200)
    await get('/finance/summary', 'auditor').expect(403)
    await get('/finance/summary', 'none').expect(403)
    await get('/audit/summary', 'none').expect(403)
    await get('/finance/summary', 'anon').expect(401)
    await get('/audit/summary', 'anon').expect(401)
  })

  it('validates the window: 1 to 90 whole days, otherwise 400, and never a tenant from the query', async () => {
    for (const bad of ['days=0', 'days=91', 'days=abc', 'days=1.5']) { await get(`/finance/summary?${bad}`).expect(400); await get(`/audit/summary?${bad}`).expect(400) }
    const s = await finance(`?days=1&tenantId=${tenantB}`)
    expect(s.window.days).toBe(1)
    expect(s.wallets.data.total).toBe(3) // still tenant A: the session decides
  })

  it('RUNTIME-ROLE: under the non-bypass API runtime role the sections degrade to an explicit "unavailable", never to zero', async () => {
    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const url = new URL(previous as string); url.username = API_RUNTIME_LOGIN_ROLE; url.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: url.toString() } as never)
      await runtime.$connect()
      const service = new OperationsFinanceAuditService(runtime)
      const f = await service.financeSummary(tenantA, {})
      // Wallet and LedgerEntry are outside the runtime role's grants (ADR 0008/0013): unavailable, never zero. Update this expectation only with a reviewed grant change.
      expect(f.wallets).toEqual({ state: 'unavailable', reason: OPERATIONS_READ_DENIED })
      expect(f.ledger).toEqual({ state: 'unavailable', reason: OPERATIONS_READ_DENIED })
      const a = await service.auditSummary(tenantA, {})
      if (a.events.state === 'unavailable') expect(a.events.reason).toBe(OPERATIONS_READ_DENIED)
      else expect(a.events.data.byDomain.find((d) => d.domain === 'booking')?.events).toBe(2)
    } finally { await runtime?.$disconnect(); await owner.$disconnect() }
  })

  it('PERF: each summary runs a fixed number of aggregate queries', async () => {
    const queries: string[] = []
    const probe = new PrismaService({ log: [{ emit: 'event', level: 'query' }] } as never)
    ;(probe as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on('query', (q) => queries.push(q.query))
    await probe.$connect()
    const service = new OperationsFinanceAuditService(probe)
    await service.financeSummary(tenantA, {}); const finQueries = queries.filter((q) => /FROM "public"\."(Wallet|LedgerEntry)"/.test(q)).length
    queries.length = 0
    await service.auditSummary(tenantA, {}); const audQueries = queries.filter((q) => /"public"\."AuditEvent"/.test(q)).length
    await probe.$disconnect()
    expect(finQueries).toBe(3); expect(audQueries).toBe(3)
  })
})
