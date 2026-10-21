import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { certifyFinpostRole, deprovisionFinpostRole, finpostGrantStatements, FINPOST_PROBES, provisionFinpostRole } from '../src/database/finance-posting-role'
import { BookingFinancePostingDatabase } from '../src/booking-finance-posting/booking-finance-posting.database'
import { BookingFinancePostingService } from '../src/booking-finance-posting/booking-finance-posting.service'
import { BookingFinancePostingWorker } from '../src/booking-finance-posting/booking-finance-posting.worker'
import { CancellationSettlementService } from '../src/agent/cancellation-settlement.service'
import { BookingFinancePostingBacklogService } from '../src/booking-finance-posting/booking-finance-posting-backlog.service'
import { BookingPayablesService } from '../src/booking-finance-posting/booking-payables.service'
import { BookingRevenueService } from '../src/booking-finance-posting/booking-revenue.service'
import { OperationsLedgerIntegrityService } from '../src/admin-operations/operations-ledger-integrity.service'
import { eraseLedger } from './ledger-erasure'

jest.setTimeout(120_000)

/**
 * ADR 0076: the Finance consumer of BookingFinanceEvent, run end to end as the narrow `fbeds_finpost` login against PostgreSQL. Bookings and events are seeded the way booking
 * operations leaves them (an Admin-originated booking records money facts and nothing else); the agency account is opened by funding, never by the consumer.
 */
describe('booking finance posting under its narrow database role (ADR 0076, PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `finpost-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const loginRole = `fbeds_finpost_t${randomBytes(4).toString('hex')}`
  let loginUrl = ''
  let narrow: PrismaClient
  let service: BookingFinancePostingService
  let database: BookingFinancePostingDatabase
  let tenantId = '', otherTenantId = '', agencyId = '', walletId = '', supplierId = '', actor = ''
  let seq = 0

  const sell = 100_000n
  const net = 80_000n

  async function booking(label: string, over: Record<string, unknown> = {}) {
    return owner.booking.create({ data: { tenantId, supplierId, agencyId, reference: `${suffix}-${label}`, supplier: 'Supplier One', hotelId: 'fixture-hotel', status: 'CONFIRMED', currency: 'AED', totalMinor: sell, netMinor: net, paymentMode: 'CREDIT', idempotencyKey: `${suffix}-${label}-${++seq}`, searchSnapshot: {}, ...over } as never })
  }
  let tick = 0
  /** Events are ordered by creation time; space them so the order of the calls below is the order of the facts. */
  const fact = (bookingId: string, type: string, over: Record<string, unknown> = {}) =>
    owner.bookingFinanceEvent.create({ data: { tenantId, bookingId, type: type as never, seq: ++seq, currency: 'AED', sellMinor: sell, netMinor: net, paymentMode: 'CREDIT', actorUserId: actor, payload: {}, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++tick)), ...over } })
  const entries = async (bookingId: string) => (await owner.ledgerEntry.findMany({ where: { tenantId, reference: { startsWith: `booking:${bookingId}` } }, orderBy: [{ immutableAt: 'asc' }, { id: 'asc' }] })).map((e) => `${e.type}:${e.amountMinor}`)
  const payable = async (bookingId: string) => (await owner.supplierPayableEntry.findMany({ where: { tenantId, bookingId }, orderBy: { createdAt: 'asc' } })).map((e) => `${e.kind}:${e.amountMinor}`)
  const posting = (eventId: string) => owner.bookingFinancePosting.findUniqueOrThrow({ where: { tenantId_eventId: { tenantId, eventId } } })
  const cancellationRefund = async (bookingId: string) => (await owner.cancellation.findUnique({ where: { bookingId } }))?.refundMinor ?? null
  /** The Agent flow's lifecycle for a charge: reserve, convert the reservation, charge. */
  const lifecycle = (amount: bigint = sell) => [`HOLD:-${amount}`, `RELEASE:${amount}`, `DEBIT:-${amount}`]
  const balance = async () => (await owner.ledgerEntry.aggregate({ where: { tenantId, walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n

  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionFinpostRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString()); login.username = loginRole; login.password = password
    loginUrl = login.toString()
    narrow = new PrismaClient({ datasourceUrl: loginUrl })
    database = new BookingFinancePostingDatabase({ BOOKING_FINANCE_POSTING_DATABASE_URL: loginUrl, DATABASE_URL: ownerUrl.toString() })
    service = new BookingFinancePostingService(database)

    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    otherTenantId = (await owner.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })).id
    actor = (await owner.user.create({ data: { email: `${suffix}@example.test` } })).id
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} LLC`, displayName: 'Posting Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    agencyId = (await owner.agency.create({ data: { tenantId, code: suffix.toUpperCase(), name: 'Posting Travel', createdById: actor } })).id
    walletId = (await owner.wallet.create({ data: { tenantId, agencyId, currency: 'AED' } })).id
  })

  afterAll(async () => {
    await database.onModuleDestroy()
    await narrow.$disconnect()
    for (const id of [tenantId, otherTenantId]) {
      await eraseLedger(owner, { where: { tenantId: id } })
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await tx.$executeRawUnsafe('DELETE FROM "Cancellation" WHERE booking_id IN (SELECT id FROM "Booking" WHERE tenant_id = $1)', id)
        for (const table of ['SupplierPayableEntry', 'BookingFinancePosting', 'BookingFinanceEvent', 'BookingEvent', 'Booking', 'Wallet', 'Agency', 'AuditEvent', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      })
    }
    await owner.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await deprovisionFinpostRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('ROLE-CERTIFY: the login passes the catalogue verifier and every privilege probe', async () => {
    const report = await certifyFinpostRole(narrow)
    expect(report.role.failures).toEqual([])
    expect(report.probes.filter((p) => !p.ok)).toEqual([])
    expect(report.probes).toHaveLength(FINPOST_PROBES.length)
    const grants = finpostGrantStatements().join('\n')
    expect(grants).not.toMatch(/GRANT (UPDATE|DELETE)[A-Z, ]* ON "(LedgerEntry|SupplierPayableEntry)"/)
    expect(grants).not.toMatch(/ON "(users|sessions|BookingGuest|FundingReceipt|BookingEvent)"/)
  })

  it('CONFIRM: debits the agency, accrues the supplier payable, records the posting and one audit event', async () => {
    const b = await booking('confirm')
    const e = await fact(b.id, 'CONFIRMED')
    const before = await balance()
    const summary = await service.drain(tenantId)
    expect(summary).toMatchObject({ posted: 1, reviewRequired: 0 })
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await payable(b.id)).toEqual([`ACCRUAL:${net}`])
    expect(await balance()).toBe(before - sell)
    expect(await posting(e.id)).toMatchObject({ status: 'POSTED', reason: null, walletId, agencyEffectMinor: -sell, payableEffectMinor: net })
    const audits = await owner.auditEvent.findMany({ where: { tenantId, entityId: b.id, action: 'booking.finance.posted' } })
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0].payload)).not.toMatch(/email|password|token/i)
    expect(audits[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
  })

  it('IDEMPOTENT: draining again, or twice at once, posts nothing more', async () => {
    const b = await booking('idem')
    await fact(b.id, 'CONFIRMED')
    await Promise.all([service.drain(tenantId), service.drain(tenantId), service.drain(tenantId)])
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await payable(b.id)).toEqual([`ACCRUAL:${net}`])
    expect(await owner.bookingFinancePosting.count({ where: { tenantId, bookingId: b.id } })).toBe(1)
  })

  it('ON-REQUEST: a hold, then the confirmation releases it and charges once; the balance ends at minus the sell price', async () => {
    const b = await booking('onrequest')
    await fact(b.id, 'ON_REQUEST_HOLD', { netMinor: null })
    const before = await balance()
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([`HOLD:-${sell}`])
    await fact(b.id, 'CONFIRMED')
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await balance()).toBe(before - sell)
  })

  it('ON-REQUEST: a rejected request releases the hold once', async () => {
    const b = await booking('rejected', { status: 'FAILED' })
    await fact(b.id, 'ON_REQUEST_HOLD', { netMinor: null })
    await fact(b.id, 'HOLD_RELEASED', { netMinor: null })
    const before = await balance()
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([`HOLD:-${sell}`, `RELEASE:${sell}`])
    expect(await balance()).toBe(before)
    expect(await payable(b.id)).toEqual([])
  })

  it('AGENT-FLOW: a booking the Agent path already charged is never charged again, and the skip is recorded', async () => {
    const b = await booking('agent')
    const k = `booking:${b.id}:authorize`
    for (const [type, amountMinor, key] of [['HOLD', -sell, k], ['RELEASE', sell, `${k}:settle-release`], ['DEBIT', -sell, `${k}:settle-debit`]] as const) {
      await owner.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency: 'AED', reference: `booking:${b.id}`, idempotencyKey: key } })
    }
    const e = await fact(b.id, 'CONFIRMED')
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await posting(e.id)).toMatchObject({ status: 'SKIPPED', reason: 'ALREADY_CHARGED_ON_LEDGER' })
    expect(await payable(b.id)).toEqual([])
  })

  it('PAY-AT-HOTEL: moves no money through us', async () => {
    const b = await booking('pah', { paymentMode: 'PAY_AT_HOTEL' })
    const e = await fact(b.id, 'CONFIRMED', { paymentMode: 'PAY_AT_HOTEL' })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([])
    expect(await payable(b.id)).toEqual([])
    expect(await posting(e.id)).toMatchObject({ status: 'SKIPPED', reason: 'PAY_AT_HOTEL' })
  })

  it('CANCEL: refunds sell minus penalty, keeps the supplier accrual under a penalty, and a later waiver tops up the difference', async () => {
    const b = await booking('cancel', { status: 'CANCELLED' })
    await fact(b.id, 'CONFIRMED')
    await fact(b.id, 'CANCELLED', { penaltyMinor: 20_000n, refundMinor: 80_000n })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([...lifecycle(), 'REFUND:80000'])
    expect(await payable(b.id)).toEqual([`ACCRUAL:${net}`])
    expect(await cancellationRefund(b.id)).toBe(80_000n)
    await fact(b.id, 'PENALTY_WAIVED', { penaltyMinor: 5_000n, refundMinor: 95_000n })
    await service.drain(tenantId)
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([...lifecycle(), 'REFUND:80000', 'REFUND:15000'])
    expect(await cancellationRefund(b.id)).toBe(95_000n)
    const refunded = (await owner.ledgerEntry.aggregate({ where: { tenantId, walletId, reference: `booking:${b.id}`, type: 'REFUND' }, _sum: { amountMinor: true } }))._sum.amountMinor
    expect(refunded).toBe(95_000n)
  })

  it('CANCEL: a penalty-free cancellation refunds in full and reverses the supplier accrual', async () => {
    const b = await booking('cancelfree', { status: 'CANCELLED' })
    await fact(b.id, 'CONFIRMED')
    await fact(b.id, 'CANCELLED', { penaltyMinor: 0n, refundMinor: sell })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([...lifecycle(), `REFUND:${sell}`])
    expect(await payable(b.id)).toEqual([`ACCRUAL:${net}`, `REVERSAL:-${net}`])
    expect(await cancellationRefund(b.id)).toBe(sell)
  })

  it('CANCEL: a full penalty refunds nothing but still writes the Cancellation record the integrity monitor ties to', async () => {
    const b = await booking('fullpenalty', { status: 'CANCELLED' })
    await fact(b.id, 'CONFIRMED')
    await fact(b.id, 'CANCELLED', { penaltyMinor: sell, refundMinor: 0n })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await cancellationRefund(b.id)).toBe(0n)
    expect(await payable(b.id)).toEqual([`ACCRUAL:${net}`])
  })

  it('CANCEL: an undetermined penalty posts no refund, then the person\'s decision does', async () => {
    const b = await booking('undetermined', { status: 'CANCELLED' })
    await fact(b.id, 'CONFIRMED')
    const c = await fact(b.id, 'CANCELLED', { penaltyMinor: null, refundMinor: null })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle())
    expect(await posting(c.id)).toMatchObject({ status: 'SKIPPED', reason: 'PENALTY_UNDETERMINED' })
    expect(await cancellationRefund(b.id)).toBeNull()
    await fact(b.id, 'PENALTY_DECIDED', { penaltyMinor: 30_000n, refundMinor: 70_000n })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([...lifecycle(), 'REFUND:70000'])
    expect(await cancellationRefund(b.id)).toBe(70_000n)
  })

  it('AMENDMENT: one recorded before the confirmation posted is folded in: charged once at the current total, and the amendment is reflected, not posted twice', async () => {
    const b = await booking('amend', { totalMinor: 120_000n, netMinor: 95_000n })
    const confirmed = await fact(b.id, 'CONFIRMED')
    const amended = await fact(b.id, 'AMENDED', { sellMinor: 120_000n, netMinor: 95_000n, adjustmentMinor: 20_000n })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual(lifecycle(120_000n))
    expect(await payable(b.id)).toEqual(['ACCRUAL:95000'])
    expect(await posting(confirmed.id)).toMatchObject({ status: 'POSTED', agencyEffectMinor: -120_000n, payableEffectMinor: 95_000n })
    expect(await posting(amended.id)).toMatchObject({ status: 'SKIPPED', reason: 'AMENDMENT_ALREADY_REFLECTED' })
    await fact(b.id, 'CANCELLED', { sellMinor: 120_000n, netMinor: 95_000n, penaltyMinor: 0n, refundMinor: 120_000n })
    await service.drain(tenantId)
    expect((await entries(b.id)).slice(-1)).toEqual(['REFUND:120000'])
    expect((await payable(b.id)).slice(-1)).toEqual(['REVERSAL:-95000'])
  })

  it('AMENDMENT: one recorded after the booking was charged at another total posts nothing and waits for a Finance decision, and blocks the booking\'s later events', async () => {
    const b = await booking('amendlate')
    await fact(b.id, 'CONFIRMED')
    await service.drain(tenantId)
    const amended = await fact(b.id, 'AMENDED', { sellMinor: 130_000n, netMinor: 100_000n, adjustmentMinor: 30_000n })
    const cancelled = await fact(b.id, 'CANCELLED', { sellMinor: 130_000n, netMinor: 100_000n, penaltyMinor: 0n, refundMinor: 130_000n })
    await service.drain(tenantId)
    expect(await posting(amended.id)).toMatchObject({ status: 'REVIEW_REQUIRED', reason: 'AMENDMENT_NEEDS_LEDGER_ADJUSTMENT' })
    expect(await owner.bookingFinancePosting.findUnique({ where: { tenantId_eventId: { tenantId, eventId: cancelled.id } } })).toBeNull()
    expect(await entries(b.id)).toEqual(lifecycle())
  })

  it('ORDER: a booking whose confirmation needs review does not post its later cancellation refund', async () => {
    const b = await booking('blocked', { status: 'CANCELLED', paymentMode: null })
    const confirmed = await fact(b.id, 'CONFIRMED', { paymentMode: null })
    const cancelled = await fact(b.id, 'CANCELLED', { paymentMode: null, penaltyMinor: 0n, refundMinor: sell })
    const summary = await service.drain(tenantId)
    expect(summary.reviewRequired).toBeGreaterThanOrEqual(1)
    expect(await posting(confirmed.id)).toMatchObject({ status: 'REVIEW_REQUIRED', reason: 'PAYMENT_MODE_UNKNOWN' })
    expect(await owner.bookingFinancePosting.findUnique({ where: { tenantId_eventId: { tenantId, eventId: cancelled.id } } })).toBeNull()
    expect(await entries(b.id)).toEqual([])
    // Finance completes the booking; after the retry window the events post in order: the charge first, then the refund it refunds.
    await owner.$executeRawUnsafe(`UPDATE "Booking" SET payment_mode = 'CREDIT' WHERE id = $1`, b.id)
    await service.drain(tenantId, { now: new Date(Date.now() + 10 * 60_000) })
    expect(await entries(b.id)).toEqual([...lifecycle(), `REFUND:${sell}`])
    expect(await posting(confirmed.id)).toMatchObject({ status: 'POSTED', attempts: 2 })
    expect(await posting(cancelled.id)).toMatchObject({ status: 'POSTED' })
  })

  it('SETTLEMENT: the API-side cancellation settlement recognises a booking charged here as ledger-charged, and credits nothing more', async () => {
    const b = await booking('settle', { status: 'CANCELLED' })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, fromStatus: 'CONFIRMED', toStatus: 'CANCEL_REQUESTED', actorType: 'USER', actorId: actor, action: 'requestCancellation', payload: { penaltyQuote: { status: 'quotable', currency: 'AED', sellMinor: sell.toString(), penaltyMinor: '20000', refundMinor: '80000', ruleDaysBeforeCheckin: 7, basis: 'RULE', evaluatedAt: new Date().toISOString() } } } })
    await fact(b.id, 'CONFIRMED')
    await fact(b.id, 'CANCELLED', { penaltyMinor: 20_000n, refundMinor: 80_000n })
    await service.drain(tenantId)
    expect(await entries(b.id)).toEqual([...lifecycle(), 'REFUND:80000'])
    const settlement = new CancellationSettlementService(owner)
    // It recognises the charge (not `not_ledger_charged`), finds the refund posted and the Cancellation record in place, and credits nothing more.
    expect(await settlement.settle({ tenantId, userId: actor, requestId: `${suffix}-settle`, bookingId: b.id, source: 'test' })).toMatchObject({ outcome: 'already_settled', refundMinor: '80000' })
    expect(await settlement.pending(tenantId)).not.toContain(b.id)
    expect(await entries(b.id)).toEqual([...lifecycle(), 'REFUND:80000'])
  })

  it('NO-ACCOUNT: an agency with no open account is reviewed and nothing is opened or posted; once funded, the retry posts', async () => {
    const agency2 = (await owner.agency.create({ data: { tenantId, code: `${suffix}-2`.toUpperCase(), name: 'No Account Travel', createdById: actor } })).id
    const b = await booking('noacct', { agencyId: agency2 })
    const e = await fact(b.id, 'CONFIRMED')
    await service.drain(tenantId)
    expect(await posting(e.id)).toMatchObject({ status: 'REVIEW_REQUIRED', reason: 'NO_WALLET' })
    expect(await owner.wallet.count({ where: { tenantId, agencyId: agency2 } })).toBe(0)
    expect(await owner.ledgerEntry.count({ where: { tenantId, reference: `booking:${b.id}` } })).toBe(0)
    // Within the retry window the event is left alone; past it, with the account opened, it posts.
    await service.drain(tenantId)
    expect((await posting(e.id)).attempts).toBe(1)
    const wallet2 = await owner.wallet.create({ data: { tenantId, agencyId: agency2, currency: 'AED' } })
    await service.drain(tenantId, { now: new Date(Date.now() + 10 * 60_000) })
    expect(await posting(e.id)).toMatchObject({ status: 'POSTED', walletId: wallet2.id })
    expect((await posting(e.id)).attempts).toBe(2)
    expect(await entries(b.id)).toEqual(lifecycle())
  })

  it('NET-UNKNOWN: a confirmation with no recorded net posts nothing until the net is known, and never accrues a zero payable', async () => {
    const b = await booking('nonet', { netMinor: null })
    const e = await fact(b.id, 'CONFIRMED', { netMinor: null })
    await service.drain(tenantId)
    expect(await posting(e.id)).toMatchObject({ status: 'REVIEW_REQUIRED', reason: 'NET_UNKNOWN' })
    expect(await entries(b.id)).toEqual([])
    expect(await payable(b.id)).toEqual([])
    // Operations records the cost on the booking; the retry accrues it.
    await owner.$executeRawUnsafe(`UPDATE "Booking" SET net_minor = 70000 WHERE id = $1`, b.id)
    await service.drain(tenantId, { now: new Date(Date.now() + 10 * 60_000) })
    expect(await payable(b.id)).toEqual(['ACCRUAL:70000'])
    expect(await entries(b.id)).toEqual(lifecycle())
  })

  it('INTEGRITY: every booking this consumer posted ties out under the ledger integrity monitor (ADR 0068), with no critical finding', async () => {
    const report = await new OperationsLedgerIntegrityService(owner).report(tenantId, {}, owner)
    expect(report.scan.capped).toBe(false)
    expect(report.counts.byCode.filter((c) => c.severity === 'critical')).toEqual([])
    expect(report.verdict).not.toBe('ISSUES')
    expect(report.scan.bookings).toBeGreaterThan(8)
    // Control: the monitor is not blind. A lone DEBIT (what a naive consumer would post for a direct confirmation) is exactly what it reports.
    const naive = await booking('naive')
    await owner.ledgerEntry.create({ data: { tenantId, walletId, type: 'DEBIT', amountMinor: -sell, currency: 'AED', reference: `booking:${naive.id}`, idempotencyKey: `booking:${naive.id}:authorize:settle-debit` } })
    const control = await new OperationsLedgerIntegrityService(owner).report(tenantId, {}, owner)
    expect(control.findings.filter((f) => f.bookingId === naive.id).map((f) => f.code)).toEqual(expect.arrayContaining(['CHARGE_WITHOUT_RESERVATION', 'SETTLEMENT_UNBALANCED']))
    expect(control.findings.filter((f) => f.severity === 'critical' && f.bookingId !== naive.id)).toEqual([])
  })

  it('BACKLOG: complete counts, the events that need a person with their stable reason, and what has not been attempted; nothing is written', async () => {
    const review = await booking('backlog-review', { paymentMode: null })
    const stuck = await fact(review.id, 'CONFIRMED', { paymentMode: null })
    const behind = await fact(review.id, 'CANCELLED', { paymentMode: null, penaltyMinor: 0n, refundMinor: sell })
    const pah = await booking('backlog-pah', { paymentMode: 'PAY_AT_HOTEL' })
    await fact(pah.id, 'CONFIRMED', { paymentMode: 'PAY_AT_HOTEL' })
    await service.drain(tenantId)
    const backlog = new BookingFinancePostingBacklogService(database)
    const before = await owner.bookingFinancePosting.count({ where: { tenantId } })
    const view = await backlog.backlog(tenantId)
    expect(await owner.bookingFinancePosting.count({ where: { tenantId } })).toBe(before)
    expect(view.counts.posted).toBe(await owner.bookingFinancePosting.count({ where: { tenantId, status: 'POSTED' } }))
    expect(view.counts.reviewRequired).toBe(view.review.length)
    expect(view.review.find((r) => r.eventId === stuck.id)).toMatchObject({ reason: 'PAYMENT_MODE_UNKNOWN', bookingId: review.id, eventType: 'CONFIRMED', currency: 'AED', sellMinor: sell.toString(), attempts: 1 })
    expect(view.review.map((r) => r.reason)).toContain('AMENDMENT_NEEDS_LEDGER_ADJUSTMENT')
    expect(view.waiting.map((w) => w.eventId)).toContain(behind.id)
    expect(view.counts.waiting).toBeGreaterThanOrEqual(1)
    expect(view.skippedByReason).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'PAY_AT_HOTEL' }), expect.objectContaining({ reason: 'ALREADY_CHARGED_ON_LEDGER' })]))
    expect(JSON.stringify(view)).not.toMatch(/email|password|guest/i)
    await expect(new BookingFinancePostingBacklogService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL })).backlog(tenantId)).rejects.toMatchObject({ response: { code: 'BOOKING_FINANCE_POSTING_UNAVAILABLE' } })
    expect((await backlog.backlog(otherTenantId)).counts.posted).toBe(0)
  })

  it('REVENUE: sales, refunds and supplier cost per currency tie to the ledger and the payable entries; currencies are never added; names resolve', async () => {
    const usdWallet = await owner.wallet.create({ data: { tenantId, agencyId, currency: 'USD' } })
    const usd = await booking('usd', { currency: 'USD', totalMinor: 50_000n, netMinor: 40_000n })
    await owner.bookingFinanceEvent.create({ data: { tenantId, bookingId: usd.id, type: 'CONFIRMED', seq: ++seq, currency: 'USD', sellMinor: 50_000n, netMinor: 40_000n, paymentMode: 'CREDIT', payload: {}, createdAt: new Date(Date.UTC(2026, 9, 1, 1, 0, ++tick)) } })
    await service.drain(tenantId)
    const revenue = new BookingRevenueService(database, owner)
    const report = await revenue.report(tenantId, {})
    expect(report).toMatchObject({ basis: 'POSTING_DATE' })
    expect(report.currencies.map((c) => c.currency)).toEqual(['AED', 'USD'])

    // AED ties to the ledger: the DEBIT and REFUND entries of the bookings the consumer posted, and to the payable entries.
    const posted = await owner.bookingFinancePosting.findMany({ where: { tenantId, status: 'POSTED', currency: 'AED' }, select: { bookingId: true } })
    const refs = [...new Set(posted.map((p) => `booking:${p.bookingId}`))]
    const ledger = await owner.ledgerEntry.findMany({ where: { tenantId, currency: 'AED', reference: { in: refs } }, select: { type: true, amountMinor: true, idempotencyKey: true } })
    const ledgerSales = ledger.filter((e) => e.type === 'DEBIT').reduce((n, e) => n - e.amountMinor, 0n)
    const ledgerRefunds = ledger.filter((e) => e.type === 'REFUND').reduce((n, e) => n + e.amountMinor, 0n)
    const cost = (await owner.supplierPayableEntry.aggregate({ where: { tenantId, currency: 'AED' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
    const aed = report.currencies[0]
    expect(BigInt(aed.salesMinor)).toBe(ledgerSales)
    expect(BigInt(aed.refundsMinor)).toBe(ledgerRefunds)
    expect(BigInt(aed.netRevenueMinor)).toBe(ledgerSales - ledgerRefunds)
    expect(BigInt(aed.supplierCostMinor)).toBe(cost)
    expect(BigInt(aed.marginMinor)).toBe(ledgerSales - ledgerRefunds - cost)
    expect(aed.chargedEvents).toBeGreaterThan(5)
    expect(aed.byAgency.reduce((n, r) => n + BigInt(r.netRevenueMinor), 0n)).toBe(BigInt(aed.netRevenueMinor))
    expect(aed.byAgency.map((r) => r.name)).toEqual(expect.arrayContaining(['Posting Travel', 'No Account Travel']))
    expect(aed.bySupplier).toEqual([expect.objectContaining({ supplierId, name: 'Posting Supplier', costMinor: cost.toString() })])

    // USD is its own block: one charge of 50,000, cost 40,000, margin 10,000.
    expect(report.currencies[1]).toMatchObject({ currency: 'USD', salesMinor: '50000', refundsMinor: '0', netRevenueMinor: '50000', supplierCostMinor: '40000', marginMinor: '10000', chargedEvents: 1 })
    expect(usdWallet.id).toBeTruthy()

    // A window with nothing in it is an empty report, an invalid one is refused, another tenant sees nothing, and an unavailable consumer is a 503.
    expect((await revenue.report(tenantId, { from: '2020-01-01', to: '2020-01-31' })).currencies).toEqual([])
    await expect(revenue.report(tenantId, { from: '2026-10-05', to: '2026-10-01' })).rejects.toMatchObject({ response: { code: 'REVENUE_REPORT_INVALID_RANGE' } })
    expect((await revenue.report(otherTenantId, {})).currencies).toEqual([])
    await expect(new BookingRevenueService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL }), owner).report(tenantId, {})).rejects.toMatchObject({ response: { code: 'BOOKING_FINANCE_POSTING_UNAVAILABLE' } })
  })

  it('PAYABLES: per supplier and currency by kind, tying to the payable entries and to the revenue report\'s cost; currencies stay apart', async () => {
    const payables = new BookingPayablesService(database, owner)
    const view = await payables.payables(tenantId)
    const rows = (currency: string) => view.rows.filter((r) => r.currency === currency)
    const sum = async (currency: string, kind?: 'ACCRUAL' | 'ADJUSTMENT' | 'REVERSAL') => (await owner.supplierPayableEntry.aggregate({ where: { tenantId, currency, ...(kind ? { kind } : {}) }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
    expect(rows('AED')).toHaveLength(1)
    expect(rows('AED')[0]).toMatchObject({ supplierId, name: 'Posting Supplier', accrualsMinor: (await sum('AED', 'ACCRUAL')).toString(), reversalsMinor: (await sum('AED', 'REVERSAL')).toString(), balanceMinor: (await sum('AED')).toString() })
    expect(BigInt(rows('AED')[0].accrualsMinor) + BigInt(rows('AED')[0].adjustmentsMinor) + BigInt(rows('AED')[0].reversalsMinor)).toBe(BigInt(rows('AED')[0].balanceMinor))
    expect(BigInt(rows('AED')[0].reversalsMinor)).toBeLessThanOrEqual(0n)
    expect(rows('USD')).toEqual([expect.objectContaining({ balanceMinor: '40000', entries: 1 })])
    expect(rows('AED')[0].balanceMinor).toBe((await new BookingRevenueService(database, owner).report(tenantId, {})).currencies.find((c) => c.currency === 'AED')?.supplierCostMinor)
    expect(view.truncated).toBe(false)
    expect((await payables.payables(otherTenantId)).rows).toEqual([])
    await expect(new BookingPayablesService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL }), owner).payables(tenantId)).rejects.toMatchObject({ response: { code: 'BOOKING_FINANCE_POSTING_UNAVAILABLE' } })
  })

  it('AGING: open balance per booking aged from its first accrual into four buckets; a reversed booking owes nothing; currencies stay apart', async () => {
    const payables = new BookingPayablesService(database, owner)
    const now = new Date('2026-10-21T12:00:00.000Z')
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000 - 3_600_000)
    const supplier2 = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} Aging LLC`, displayName: 'Aging Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const entry = async (label: string, accrualAgo: number, amount: bigint, extra: Array<{ kind: 'ADJUSTMENT' | 'REVERSAL'; amount: bigint; ago: number }> = []) => {
      const b = await booking(`age-${label}`, { supplierId: supplier2 })
      const rows = [{ kind: 'ACCRUAL' as const, amount, ago: accrualAgo }, ...extra]
      for (const r of rows) {
        const e = await owner.bookingFinanceEvent.create({ data: { tenantId, bookingId: b.id, seq: ++seq, currency: 'AED', sellMinor: sell, paymentMode: 'CREDIT', payload: {}, createdAt: daysAgo(r.ago), ...(r.kind === 'ACCRUAL' ? { type: 'CONFIRMED' as const } : r.kind === 'ADJUSTMENT' ? { type: 'AMENDED' as const, adjustmentMinor: 1n } : { type: 'CANCELLED' as const, penaltyMinor: 0n, refundMinor: sell }) } })
        await owner.supplierPayableEntry.create({ data: { tenantId, bookingId: b.id, supplierId: supplier2, eventId: e.id, kind: r.kind, currency: 'AED', amountMinor: r.amount, createdAt: daysAgo(r.ago) } })
      }
    }
    await entry('a', 5, 1_000n)
    await entry('b', 31, 2_000n)                       // 31 whole days: the first day of the 31-60 bucket
    await entry('g', 30, 500n)                         // 30 whole days (and an hour): still 0-30
    await entry('c', 45, 4_000n, [{ kind: 'ADJUSTMENT', amount: 500n, ago: 2 }])   // aged from the FIRST accrual, balance 4,500
    await entry('d', 75, 8_000n)
    await entry('e', 200, 16_000n)
    await entry('f', 100, 32_000n, [{ kind: 'REVERSAL', amount: -32_000n, ago: 90 }]) // fully reversed: owes nothing, appears nowhere
    const view = await payables.aging(tenantId, now)
    const row = view.rows.find((r) => r.supplierId === supplier2 && r.currency === 'AED')!
    expect(row.name).toBe('Aging Supplier')
    expect(row.buckets.map((b) => [b.bucket, b.amountMinor, b.bookings])).toEqual([['D0_30', '1500', 2], ['D31_60', '6500', 2], ['D61_90', '8000', 1], ['D91_PLUS', '16000', 1]])
    expect(row.totalMinor).toBe('32000')
    expect(row.bookings).toBe(6)
    // The aged total plus the other suppliers' open balances equals the open balance of every booking with a positive balance.
    const open = await owner.supplierPayableEntry.groupBy({ by: ['bookingId'], where: { tenantId, currency: 'AED' }, _sum: { amountMinor: true } })
    const aged = view.rows.filter((r) => r.currency === 'AED').reduce((n, r) => n + BigInt(r.totalMinor), 0n)
    expect(aged).toBe(open.reduce((n, g) => ((g._sum.amountMinor ?? 0n) > 0n ? n + (g._sum.amountMinor ?? 0n) : n), 0n))
    expect(view.rows.some((r) => r.currency === 'USD')).toBe(true)
    expect(view.truncated).toBe(false)
    expect((await payables.aging(otherTenantId, now)).rows).toEqual([])
    await expect(new BookingPayablesService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL }), owner).aging(tenantId)).rejects.toMatchObject({ response: { code: 'BOOKING_FINANCE_POSTING_UNAVAILABLE' } })
  })

  it('ISOLATION: another tenant\'s events are never read or posted, and the due list names only tenants with work', async () => {
    const otherBooking = await owner.booking.create({ data: { tenantId: otherTenantId, reference: `${suffix}-other`, supplier: 'S', hotelId: 'h', status: 'CONFIRMED', currency: 'AED', totalMinor: 10_000n, idempotencyKey: `${suffix}-other-1`, searchSnapshot: {}, paymentMode: 'CREDIT' } as never })
    await owner.bookingFinanceEvent.create({ data: { tenantId: otherTenantId, bookingId: otherBooking.id, type: 'CONFIRMED', seq: 1, currency: 'AED', sellMinor: 10_000n, netMinor: 8_000n, paymentMode: 'CREDIT', payload: {} } })
    const due = await database.dueTenantIds()
    expect(due).toContain(otherTenantId)
    const summary = await service.drain(tenantId)
    expect(summary.tenantId).toBe(tenantId)
    expect(await owner.bookingFinancePosting.count({ where: { tenantId: otherTenantId } })).toBe(0)
    const worker = new BookingFinancePostingWorker(database, service, { BOOKING_FINANCE_POSTING_WORKER_ENABLED: 'true', BOOKING_FINANCE_POSTING_ENABLED: 'true' })
    await worker.runOnce()
    expect(await owner.bookingFinancePosting.count({ where: { tenantId: otherTenantId } })).toBe(1)
  })

  it('IMMUTABLE: a final posting, a payable entry and the ledger cannot be changed, even by the owner', async () => {
    const posted = await owner.bookingFinancePosting.findFirstOrThrow({ where: { tenantId, status: 'POSTED' } })
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingFinancePosting" SET reason = 'X_ABC' WHERE id = $1`, posted.id)).rejects.toThrow(/immutable/i)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "BookingFinancePosting" WHERE id = $1`, posted.id)).rejects.toThrow(/never deleted/i)
    const entry = await owner.supplierPayableEntry.findFirstOrThrow({ where: { tenantId } })
    await expect(owner.$executeRawUnsafe(`UPDATE "SupplierPayableEntry" SET amount_minor = 1 WHERE id = $1`, entry.id)).rejects.toThrow(/append-only/i)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "SupplierPayableEntry" WHERE id = $1`, entry.id)).rejects.toThrow(/append-only/i)
  })

  it('UNAVAILABLE: with no role credential nothing is read or posted and the answer is the typed 503, never a fallback', async () => {
    const unconfigured = new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL })
    expect(unconfigured.configured()).toBe(false)
    const svc = new BookingFinancePostingService(unconfigured)
    await expect(svc.drain(tenantId)).rejects.toMatchObject({ response: { code: 'BOOKING_FINANCE_POSTING_UNAVAILABLE' } })
  })
})
