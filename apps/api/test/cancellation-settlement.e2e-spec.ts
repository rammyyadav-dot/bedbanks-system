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
import { CancellationSettlementService } from '../src/agent/cancellation-settlement.service'
import { eraseLedger } from './ledger-erasure'

jest.setTimeout(120_000)

/**
 * ADR 0069 (audit F3): a booking cancelled outside the agent path credits its agency per the effective penalty, on the API connection.
 * Bookings are seeded in the state booking operations leaves them (CANCELLED, the request's penalty quote, finance events), with the
 * agency charged on the ledger exactly as the agent booking path charges it.
 */
describe('cancellation settlement (PostgreSQL, HTTP)', () => {
  const prisma = new PrismaClient()
  const suffix = `cs-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'cancellation-settlement-password'
  let app: INestApplication
  let settlement: CancellationSettlementService
  let tenantId = '', accountId = '', agencyId = '', operator = ''
  const userIds: string[] = []
  const cookies: Record<string, string> = {}
  let seq = 0
  const TOTAL = 100_000n

  async function user(label: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    return { id: u.id, email }
  }
  const entry = (type: 'HOLD' | 'RELEASE' | 'DEBIT' | 'REFUND', amountMinor: bigint, key: string, bookingId: string) =>
    prisma.ledgerEntry.create({ data: { tenantId, walletId: accountId, type, amountMinor, currency: 'AED', reference: `booking:${bookingId}`, idempotencyKey: key } })
  /** A confirmed, charged booking moved to CANCELLED by booking operations, with the penalty quote its cancellation request stored. */
  async function cancelled(label: string, quote: { penaltyMinor: bigint } | 'needs_decision' | null, charged = true) {
    const b = await prisma.booking.create({ data: { tenantId, reference: `${suffix}-${label}`, supplier: 'Supplier One', hotelId: 'fixture-hotel', status: 'CANCELLED', currency: 'AED', totalMinor: TOTAL, idempotencyKey: `${suffix}-${label}-${++seq}`, searchSnapshot: {}, agencyId } })
    if (charged) {
      const k = `booking:${b.id}:authorize`
      await entry('HOLD', -TOTAL, k, b.id); await entry('RELEASE', TOTAL, `${k}:settle-release`, b.id); await entry('DEBIT', -TOTAL, `${k}:settle-debit`, b.id)
    }
    const at = new Date().toISOString()
    const penaltyQuote = quote === null ? undefined : quote === 'needs_decision'
      ? { status: 'needs_decision', reason: 'manual_review_required', detail: 'fixture', evaluatedAt: at }
      : { status: 'quotable', currency: 'AED', sellMinor: TOTAL.toString(), penaltyMinor: quote.penaltyMinor.toString(), refundMinor: (TOTAL - quote.penaltyMinor).toString(), ruleDaysBeforeCheckin: 7, basis: 'RULE', evaluatedAt: at }
    await prisma.bookingEvent.create({ data: { tenantId, bookingId: b.id, fromStatus: 'CONFIRMED', toStatus: 'CANCEL_REQUESTED', actorType: 'USER', actorId: operator, action: 'requestCancellation', payload: penaltyQuote ? { penaltyQuote } : {} } })
    await prisma.bookingEvent.create({ data: { tenantId, bookingId: b.id, fromStatus: 'CANCEL_REQUESTED', toStatus: 'CANCELLED', actorType: 'USER', actorId: operator, action: 'confirmCancellation', payload: {} } })
    return b.id
  }
  const decide = (bookingId: string, type: 'PENALTY_DECIDED' | 'PENALTY_WAIVED', penaltyMinor: bigint) =>
    prisma.bookingFinanceEvent.create({ data: { tenantId, bookingId, type, seq: ++seq, currency: 'AED', sellMinor: TOTAL, penaltyMinor, refundMinor: TOTAL - penaltyMinor, actorUserId: operator, payload: {} } })
  const refunds = async (bookingId: string) => (await prisma.ledgerEntry.findMany({ where: { tenantId, reference: `booking:${bookingId}`, type: 'REFUND' }, orderBy: { immutableAt: 'asc' } })).map(e => e.amountMinor)
  const settle = (bookingId: string) => settlement.settle({ tenantId, userId: operator, requestId: `${suffix}-${++seq}`, bookingId, source: 'test' })
  const post = (who: string, body: object) => request(app.getHttpServer()).post('/api/v1/admin/operations/finance/cancellation-settlements').set('Cookie', cookies[who]).set('Origin', 'http://localhost:3001').send(body)

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    const recon = await user('recon', ['booking.reconcile', 'finance.read'])
    const reader = await user('reader', ['finance.read'])
    operator = recon.id
    agencyId = (await prisma.agency.create({ data: { tenantId, code: `${suffix}`.toUpperCase(), name: 'Settlement Travel', createdById: operator } })).id
    accountId = (await prisma.wallet.create({ data: { tenantId, agencyId, currency: 'AED' } })).id
    await prisma.agencyCreditLimit.create({ data: { tenantId, agencyId, currency: 'AED', limitMinor: 10_000_000n, updatedById: operator } })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.setGlobalPrefix('api/v1'); app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    settlement = app.get(CancellationSettlementService, { strict: false })
    for (const [label, email] of [['recon', recon.email], ['reader', reader.email]]) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close()
    await eraseLedger(prisma, { where: { tenantId } })
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
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('CS-01 a quoted penalty credits total - penalty once, writes the cancellation record and an audit event; a replay changes nothing', async () => {
    const id = await cancelled('quoted', { penaltyMinor: 20_000n })
    expect(await settle(id)).toEqual({ bookingId: id, outcome: 'settled', refundMinor: '80000', postedMinor: '80000' })
    expect(await refunds(id)).toEqual([80_000n])
    expect(await prisma.cancellation.findUniqueOrThrow({ where: { bookingId: id } })).toMatchObject({ refundMinor: 80_000n })
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'booking.cancellation.settled', entityId: id } })
    expect(audit.payload).toMatchObject({ penaltyState: 'QUOTED', penaltyMinor: '20000', refundMinor: '80000', postedMinor: '80000', walletId: accountId })
    expect(await settle(id)).toMatchObject({ outcome: 'already_settled' })
    expect(await refunds(id)).toEqual([80_000n])
  })

  it('CS-02 an undecided penalty credits nothing until a person decides it; the decision then settles', async () => {
    const id = await cancelled('undecided', 'needs_decision')
    expect(await settle(id)).toMatchObject({ outcome: 'awaiting_penalty_decision', refundMinor: null })
    expect(await refunds(id)).toEqual([])
    expect(await prisma.cancellation.count({ where: { bookingId: id } })).toBe(0)
    await decide(id, 'PENALTY_DECIDED', 30_000n)
    expect(await settle(id)).toMatchObject({ outcome: 'settled', refundMinor: '70000', postedMinor: '70000' })
  })

  it('CS-03 a later waiver tops the refund up to the new amount; a decision below what was credited is never clawed back', async () => {
    const id = await cancelled('waiver', { penaltyMinor: 40_000n })
    await settle(id)
    await decide(id, 'PENALTY_WAIVED', 10_000n)
    expect(await settle(id)).toMatchObject({ outcome: 'topped_up', refundMinor: '90000', postedMinor: '30000' })
    expect(await refunds(id)).toEqual([60_000n, 30_000n])
    expect(await prisma.cancellation.findUniqueOrThrow({ where: { bookingId: id } })).toMatchObject({ refundMinor: 90_000n })
    await decide(id, 'PENALTY_DECIDED', 50_000n)
    expect(await settle(id)).toMatchObject({ outcome: 'review_required', refundMinor: '50000' })
    expect(await refunds(id)).toEqual([60_000n, 30_000n])
  })

  it('CS-04 agent-path cancellations (already settled) and bookings never charged on the ledger are left alone', async () => {
    const agentPath = await cancelled('agent', null)
    await entry('REFUND', 50_000n, `booking:${agentPath}:cancel-refund`, agentPath)
    await prisma.cancellation.create({ data: { bookingId: agentPath, refundMinor: 50_000n } })
    expect(await settle(agentPath)).toMatchObject({ outcome: 'already_settled', refundMinor: '50000' })
    const manual = await cancelled('manual', { penaltyMinor: 0n }, false)
    expect(await settle(manual)).toMatchObject({ outcome: 'not_ledger_charged' })
    expect(await refunds(agentPath)).toEqual([50_000n])
  })

  it('CS-05 the sweep needs booking.reconcile; a dry run lists, a run settles, and the integrity report then has no unposted refund', async () => {
    const id = await cancelled('swept', { penaltyMinor: 25_000n })
    await post('reader', {}).expect(403)
    const dry = (await post('recon', { dryRun: true }).expect(200)).body.data
    expect(dry).toMatchObject({ dryRun: true })
    expect(dry.items).toContainEqual({ bookingId: id, outcome: 'would_settle', refundMinor: null, postedMinor: null })
    expect(await refunds(id)).toEqual([])
    const run = (await post('recon', {}).expect(200)).body.data
    expect(run.items).toContainEqual({ bookingId: id, outcome: 'settled', refundMinor: '75000', postedMinor: '75000' })
    expect(run.items.find((i: { outcome: string; bookingId: string }) => i.outcome === 'settled' && i.bookingId !== id)).toBeUndefined()
    const report = (await request(app.getHttpServer()).get('/api/v1/admin/operations/finance/ledger-integrity').set('Cookie', cookies.recon).expect(200)).body.data
    expect(report.counts.byCode.map((c: { code: string }) => c.code)).not.toContain('CANCELLED_REFUND_NOT_POSTED')
    expect(report.counts.byCode.map((c: { code: string }) => c.code)).not.toContain('REFUND_MISMATCH')
    expect((await post('recon', {}).expect(200)).body.data.items.filter((i: { outcome: string }) => i.outcome === 'settled')).toEqual([])
  })
})
