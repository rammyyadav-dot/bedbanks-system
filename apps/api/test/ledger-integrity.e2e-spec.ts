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

/**
 * ADR 0068: ledger integrity and sub-ledger reconciliation over HTTP, against the real AppModule and PostgreSQL, with two tenants.
 * Tenant A seeds one clean booking lifecycle and one break of each kind the booking paths can leave behind; tenant B is clean.
 * Also pins F1: the finance dashboard uses the agency's approved credit line for agency accounts.
 */
describe('ledger integrity (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `li-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'ledger-integrity-password'
  const old = new Date(Date.now() - 3 * 3_600_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', accountA = '', accountB = '', agencyA = ''
  const userIds: string[] = []
  const cookies: Record<string, string> = {}
  let seq = 0

  async function user(label: string, tenantId: string, permissionKeys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (permissionKeys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
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
  const get = (path: string, who: string) => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const entry = (tenantId: string, walletId: string, type: 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND', amountMinor: bigint, key: string, reference: string | null, immutableAt = new Date()) =>
    prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency: 'AED', reference, idempotencyKey: key, immutableAt } })
  const booking = (tenantId: string, label: string, status: 'CONFIRMED' | 'CANCELLED' | 'FAILED' | 'PENDING_SUPPLIER', totalMinor: bigint) =>
    prisma.booking.create({ data: { tenantId, reference: `${suffix}-${label}`, supplier: 'fixture', hotelId: 'fixture-hotel', status, currency: 'AED', totalMinor, idempotencyKey: `${suffix}-${label}-${++seq}`, searchSnapshot: {} } })
  /** The postings the booking paths make: authorize, then settle (confirm) or release (compensation / reconciliation), then refund. */
  async function lifecycle(tenantId: string, walletId: string, bookingId: string, amount: bigint, steps: Array<'settle' | 'release' | ['refund', bigint]>, at = new Date()) {
    const ref = `booking:${bookingId}`, key = `booking:${bookingId}:authorize`
    await entry(tenantId, walletId, 'HOLD', -amount, key, ref, at)
    for (const s of steps) {
      if (s === 'settle') { await entry(tenantId, walletId, 'RELEASE', amount, `${key}:settle-release`, ref, at); await entry(tenantId, walletId, 'DEBIT', -amount, `${key}:settle-debit`, ref, at) }
      else if (s === 'release') await entry(tenantId, walletId, 'RELEASE', amount, `${key}:release`, ref, at)
      else await entry(tenantId, walletId, 'REFUND', s[1], `booking:${bookingId}:cancel-refund`, ref, at)
    }
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const reader = await user('reader', tenantA, ['finance.read'])
    const outsider = await user('outsider', tenantA, ['booking.read'])
    const readerB = await user('reader-b', tenantB, ['finance.read'])
    const owner = userIds[0]
    agencyA = (await prisma.agency.create({ data: { tenantId: tenantA, code: `${suffix}-A`.toUpperCase(), name: 'Integrity Travel', createdById: owner } })).id
    await prisma.agencyCreditLimit.create({ data: { tenantId: tenantA, agencyId: agencyA, currency: 'AED', limitMinor: 1_000_000n, updatedById: owner } })
    accountA = (await prisma.wallet.create({ data: { tenantId: tenantA, agencyId: agencyA, currency: 'AED' } })).id
    accountB = (await prisma.wallet.create({ data: { tenantId: tenantB, currency: 'AED', creditLimit: 1_000_000n } })).id

    // Tenant A. Clean: confirmed (b1), cancelled through the agent path with its refund (b2).
    const b1 = await booking(tenantA, 'b1', 'CONFIRMED', 40_000n); await lifecycle(tenantA, accountA, b1.id, 40_000n, ['settle'])
    const b2 = await booking(tenantA, 'b2', 'CANCELLED', 30_000n); await lifecycle(tenantA, accountA, b2.id, 30_000n, ['settle', ['refund', 20_000n]])
    await prisma.cancellation.create({ data: { bookingId: b2.id, refundMinor: 20_000n } })
    // Breaks: cancelled outside the ledger path (b3), money left reserved on a failed booking (b4), released and then also settled (b5),
    // a stale reservation (b6), a refund that differs from its cancellation record (b7), and a funding credit with no receipt.
    const b3 = await booking(tenantA, 'b3', 'CANCELLED', 50_000n); await lifecycle(tenantA, accountA, b3.id, 50_000n, ['settle'])
    const b4 = await booking(tenantA, 'b4', 'FAILED', 10_000n); await lifecycle(tenantA, accountA, b4.id, 10_000n, [])
    const b5 = await booking(tenantA, 'b5', 'CONFIRMED', 15_000n); await lifecycle(tenantA, accountA, b5.id, 15_000n, ['release', 'settle'])
    const b6 = await booking(tenantA, 'b6', 'PENDING_SUPPLIER', 5_000n); await lifecycle(tenantA, accountA, b6.id, 5_000n, [], old)
    const b7 = await booking(tenantA, 'b7', 'CANCELLED', 8_000n); await lifecycle(tenantA, accountA, b7.id, 8_000n, ['settle', ['refund', 3_000n]])
    await prisma.cancellation.create({ data: { bookingId: b7.id, refundMinor: 8_000n } })
    await entry(tenantA, accountA, 'CREDIT', 25_000n, `${suffix}-credit`, `funding:${suffix}-no-receipt`)

    // Tenant B: one clean confirmed booking on the house account.
    const bb = await booking(tenantB, 'bb', 'CONFIRMED', 7_000n); await lifecycle(tenantB, accountB, bb.id, 7_000n, ['settle'])

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api/v1')
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.reader = await login(reader); cookies.outsider = await login(outsider); cookies.readerB = await login(readerB)
  })

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await prisma.cancellation.deleteMany({ where: { booking: { tenantId } } })
      await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
      await prisma.booking.deleteMany({ where: { tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId } })
      await prisma.agencyCreditLimit.deleteMany({ where: { tenantId } })
      await prisma.agency.deleteMany({ where: { tenantId } })
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await app?.close()
    await prisma.$disconnect()
  })

  it('LI-01 finds every seeded break, and only those, with the amounts that show each one', async () => {
    const r = (await get('/finance/ledger-integrity', 'reader').expect(200)).body.data
    expect(r.verdict).toBe('ISSUES')
    expect(r.scan).toMatchObject({ accounts: 1, entries: 21, bookings: 7, capped: false })
    const byCode = Object.fromEntries(r.counts.byCode.map((c: { code: string; count: number }) => [c.code, c.count]))
    expect(byCode).toEqual({
      CANCELLED_REFUND_NOT_POSTED: 1, CREDIT_WITHOUT_RECEIPT: 1, RESERVATION_ON_CLOSED_BOOKING: 1, RESERVATION_OVER_RELEASED: 1, REFUND_MISMATCH: 1, RESERVATION_STALE: 1,
    })
    expect(r.counts).toMatchObject({ critical: 5, warning: 1 })
    const find = (code: string) => r.findings.find((f: { code: string }) => f.code === code)
    expect(find('CANCELLED_REFUND_NOT_POSTED')).toMatchObject({ severity: 'critical', accountId: accountA, agencyId: agencyA, amounts: { chargeMinor: '50000', refundMinor: '0' } })
    expect(find('REFUND_MISMATCH').amounts).toEqual({ expectedRefundMinor: '8000', refundMinor: '3000' })
    expect(find('RESERVATION_OVER_RELEASED').amounts).toEqual({ holdMinor: '15000', releasedMinor: '15000', settleReleaseMinor: '15000' })
    expect(r.findings[r.findings.length - 1]).toMatchObject({ code: 'RESERVATION_STALE', severity: 'warning', amounts: { openReservationMinor: '5000' } })
    for (const f of r.findings) for (const v of Object.values(f.amounts)) expect(v).toMatch(/^-?\d+$/)
    expect(r.definitions.CANCELLED_REFUND_NOT_POSTED).toMatch(/Finance must decide/)
  })

  it('LI-02 rolls the balance forward per currency from funding, charges, refunds and open reservations', async () => {
    const [aed] = (await get('/finance/ledger-integrity', 'reader').expect(200)).body.data.totals
    const n = (k: string) => BigInt(aed[k])
    expect(aed).toMatchObject({ currency: 'AED', accounts: 1, fundingCreditsMinor: '25000', postedReceiptsMinor: '0', refundsMinor: '23000' })
    expect(n('chargesMinor')).toBe(40_000n + 30_000n + 50_000n + 15_000n + 8_000n)
    expect(n('openReservationsMinor')).toBe(10_000n + 5_000n - 15_000n) // b4 + b6 open, b5 over-released by one release
    expect(n('balanceMinor')).toBe(n('fundingCreditsMinor') + n('otherCreditsMinor') + n('refundsMinor') - n('chargesMinor') - n('openReservationsMinor'))
  })

  it('LI-03 tenant isolation and a clean verdict: tenant B sees only its own clean ledger', async () => {
    const r = (await get('/finance/ledger-integrity', 'readerB').expect(200)).body.data
    expect(r).toMatchObject({ verdict: 'CLEAN', findings: [], scan: { accounts: 1, entries: 3, bookings: 1 } })
    expect(r.totals).toEqual([expect.objectContaining({ currency: 'AED', chargesMinor: '7000', balanceMinor: '-7000' })])
  })

  it('LI-04 RBAC and input: finance.read is required, anonymous is refused, and the stale threshold is validated', async () => {
    await get('/finance/ledger-integrity', 'outsider').expect(403)
    await get('/finance/ledger-integrity', 'anon').expect(401)
    await get('/finance/ledger-integrity?staleMinutes=1', 'reader').expect(400)
    const relaxed = (await get('/finance/ledger-integrity?staleMinutes=600', 'reader').expect(200)).body.data
    expect(relaxed.staleReservationMinutes).toBe(600)
    expect(relaxed.counts.byCode.map((c: { code: string }) => c.code)).not.toContain('RESERVATION_STALE')
  })

  it('F1 the finance dashboard uses the agency credit line: an agency account spending its approved credit is not overdrawn', async () => {
    const s = (await get('/finance/summary', 'reader').expect(200)).body.data
    expect(s.wallets.data.currencies).toEqual([expect.objectContaining({ currency: 'AED', wallets: 1, creditLimitMinor: '1000000', overdrawnWallets: 0 })])
    const balance = BigInt(s.wallets.data.currencies[0].balanceMinor)
    expect(balance < 0n).toBe(true)
    expect(s.wallets.data.currencies[0].availableCreditMinor).toBe((1_000_000n + balance).toString())
  })
})
