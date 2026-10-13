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

jest.setTimeout(120_000)

/** Ledger integrity report (ADR 0063) over HTTP, against the real AppModule and PostgreSQL. Tenant A is deliberately broken; tenant B is clean. */
describe('ledger integrity report (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `li-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'finance-audit-summary-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const at = (offsetDays: number, hours = 12) => new Date(midnight + offsetDays * 86_400_000 + hours * 3_600_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', walletAed = '', walletEur = '', walletB = ''
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

  const chain = async (tenantId: string, walletId: string, id: string, parts: Array<['HOLD' | 'RELEASE' | 'DEBIT' | 'REFUND', bigint]>, when = at(0)) => {
    for (const [type, amount] of parts) {
      await prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor: amount, currency: 'AED', reference: `booking:${id}`, idempotencyKey: `${suffix}-${id}-${type}-${++seq}`, immutableAt: when } })
    }
  }
  const report = async (who = 'both') => (await get('/ledger-integrity', who).expect(200)).body.data
  const codesFor = (r: { findings: Array<{ code: string; bookingId: string | null }> }, bookingId: string) => r.findings.filter(f => f.bookingId === bookingId).map(f => f.code).sort()

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    walletAed = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'AED', creditLimit: 1_000_000n } })).id
    walletEur = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'EUR', creditLimit: 1_000n } })).id
    walletB = (await prisma.wallet.create({ data: { tenantId: tenantB, currency: 'AED', creditLimit: 0n } })).id
    await entry(tenantA, walletAed, 'CREDIT', 500_000n, 'AED', at(-1))
    await entry(tenantA, walletEur, 'DEBIT', -5_000n, 'EUR', at(0)) // 1000 - 5000 < 0: overdrawn
    // healthy lifecycle states
    await chain(tenantA, walletAed, 'ok-held', [['HOLD', -1000n]])
    await chain(tenantA, walletAed, 'ok-released', [['HOLD', -1000n], ['RELEASE', 1000n]])
    await chain(tenantA, walletAed, 'ok-confirmed', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n]])
    await chain(tenantA, walletAed, 'ok-partial-refund', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n], ['REFUND', 400n]])
    // broken lifecycle states
    await chain(tenantA, walletAed, 'bad-refund', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n], ['REFUND', 1500n]])
    await chain(tenantA, walletAed, 'bad-settle', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -900n]])
    await chain(tenantA, walletAed, 'bad-release', [['HOLD', -1000n], ['RELEASE', 1200n]])
    await chain(tenantA, walletAed, 'stale', [['HOLD', -1000n]], at(-3))
    // tenant B: clean, and with a large balance that must never reach tenant A
    await entry(tenantB, walletB, 'CREDIT', 999_999n, 'AED', at(0))
    await chain(tenantB, walletB, 'b-ok', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n]])

    const both = await user('both', tenantA, ['finance.read', 'audit.read'])
    const finance = await user('finance', tenantA, ['finance.read'])
    const auditor = await user('auditor', tenantA, ['audit.read'])
    const none = await user('none', tenantA, [])
    const bboth = await user('bboth', tenantB, ['finance.read'])
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

  it('LI-01 permission: anonymous is 401; a user without finance.read (none, or audit.read only) is 403; finance.read is 200', async () => {
    await get('/ledger-integrity', 'anon').expect(401)
    await get('/ledger-integrity', 'none').expect(403)
    await get('/ledger-integrity', 'auditor').expect(403)
    await get('/ledger-integrity', 'finance').expect(200)
  })

  it('LI-02 healthy lifecycle states raise no finding: held, released, confirmed, and a partial refund', async () => {
    const r = await report()
    for (const id of ['ok-held', 'ok-released', 'ok-confirmed', 'ok-partial-refund']) expect(codesFor(r, id)).toEqual([])
  })

  it('LI-03 each broken booking chain is named with its own code and the amounts that explain it', async () => {
    const r = await report()
    expect(codesFor(r, 'bad-refund')).toEqual(['REFUND_EXCEEDS_CHARGE'])
    expect(codesFor(r, 'bad-settle')).toEqual(['SETTLEMENT_MISMATCH'])
    expect(codesFor(r, 'bad-release')).toEqual(['RELEASE_EXCEEDS_HOLD'])
    expect(codesFor(r, 'stale')).toEqual(['STALE_AUTHORIZATION'])
    const refund = r.findings.find((f: { bookingId: string }) => f.bookingId === 'bad-refund')
    expect(refund).toMatchObject({ severity: 'ERROR', currency: 'AED', amountsMinor: { heldMinor: '1000', releasedMinor: '1000', chargedMinor: '1000', refundedMinor: '1500' } })
    expect(r.findings.find((f: { bookingId: string }) => f.bookingId === 'stale').severity).toBe('WARNING')
  })

  it('LI-04 an overdrawn account is an error; the verdict fails; counts match the findings', async () => {
    const r = await report()
    const overdrawn = r.findings.filter((f: { code: string }) => f.code === 'ACCOUNT_OVERDRAWN')
    expect(overdrawn).toHaveLength(1)
    expect(overdrawn[0]).toMatchObject({ accountId: walletEur, currency: 'EUR', amountsMinor: { balanceMinor: '-5000', creditLineMinor: '1000' } })
    expect(r.status).toBe('FAIL')
    expect(r.counts.errors).toBe(r.findings.filter((f: { severity: string }) => f.severity === 'ERROR').length)
    expect(r.counts.warnings).toBe(1)
    expect(r.findings[0].severity).toBe('ERROR') // errors sort first
    expect(r.truncated).toBe(false)
  })

  it('LI-05 control totals are per currency, integer strings, and never added across currencies', async () => {
    const r = await report()
    expect(r.control.map((c: { currency: string }) => c.currency)).toEqual(['AED', 'EUR'])
    const aed = r.control.find((c: { currency: string }) => c.currency === 'AED')
    expect(aed).toMatchObject({ accounts: 1, creditLineMinor: '1000000', overdrawnAccounts: 0 })
    const credit = aed.byType.find((t: { type: string }) => t.type === 'CREDIT')
    expect(credit).toEqual({ type: 'CREDIT', entries: 1, sumMinor: '500000' })
    for (const c of r.control) for (const k of ['balanceMinor', 'creditLineMinor', 'availableMinor']) expect(c[k]).toMatch(/^-?\d+$/)
    expect(r.control.find((c: { currency: string }) => c.currency === 'EUR')).toMatchObject({ balanceMinor: '-5000', availableMinor: '-4000', overdrawnAccounts: 1 })
  })

  it('LI-06 tenant isolation: tenant B sees only its own clean ledger and never tenant A findings or balances', async () => {
    const b = await report('bboth')
    expect(b.status).toBe('PASS')
    expect(b.findings).toEqual([])
    expect(b.scanned).toMatchObject({ accounts: 1, bookings: 1 })
    expect(b.control).toHaveLength(1)
    expect(b.control[0]).toMatchObject({ currency: 'AED', balanceMinor: '998999' })
    const a = await report()
    expect(JSON.stringify(a)).not.toContain('b-ok')
    expect(a.control.find((c: { currency: string }) => c.currency === 'AED').balanceMinor).toBe('496200')
  })

  it('LI-07 the report is read-only: running it twice changes no ledger row', async () => {
    const before = await prisma.ledgerEntry.count({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await report(); await report()
    expect(await prisma.ledgerEntry.count({ where: { tenantId: { in: [tenantA, tenantB] } } })).toBe(before)
  })
})
