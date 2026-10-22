import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { certifyFinpostRole, deprovisionFinpostRole, finpostGrantStatements, FINPOST_PROBES, provisionFinpostRole } from '../src/database/finance-posting-role'
import { BookingFinancePostingDatabase } from '../src/booking-finance-posting/booking-finance-posting.database'
import { BookingFinancePostingService } from '../src/booking-finance-posting/booking-finance-posting.service'
import { BookingFinancePostingWorker } from '../src/booking-finance-posting/booking-finance-posting.worker'
import { CancellationSettlementService } from '../src/agent/cancellation-settlement.service'
import { BookingFinancePostingBacklogService } from '../src/booking-finance-posting/booking-finance-posting-backlog.service'
import { SupplierTermsService } from '../src/booking-finance-posting/supplier-terms.service'
import { SupplierSettlementService } from '../src/booking-finance-posting/supplier-settlement.service'
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
  let tenantId = '', otherTenantId = '', agencyId = '', walletId = '', supplierId = '', actor = '', approver = ''
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
    approver = (await owner.user.create({ data: { email: `${suffix}-approver@example.test` } })).id
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
        for (const table of ['SupplierSettlement', 'SupplierPayableEntry', 'BookingFinancePosting', 'BookingFinanceEvent', 'BookingEvent', 'Booking', 'Wallet', 'Agency', 'AuditEvent', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
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

  const code0 = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as { response?: { code?: string } }).response?.code ?? 'error')
  it('SETTLEMENT: propose, approve and reject with maker-checker, idempotency and an overpayment guard; approved payments reduce what is outstanding and are applied to the oldest bookings first', async () => {
    const settlements = new SupplierSettlementService(database, owner, { SUPPLIER_SETTLEMENT_ENABLED: 'true' })
    expect(await code0(new SupplierSettlementService(database, owner, {}).propose(tenantId, actor, { supplierId, currency: 'AED', amountMinor: '1', paidOn: '2026-10-01', paymentReference: 'WIRE-OFF-1', requestId: 'req-off-0001' }, 'off'))).toBe('SETTLEMENT_DISABLED')
    expect(await code0(new SupplierSettlementService(database, owner, {}).approve(tenantId, approver, 'x', 'off'))).toBe('SETTLEMENT_DISABLED')
    expect(await code0(new SupplierSettlementService(database, owner, {}).reject(tenantId, approver, 'x', { reason: 'nope' }, 'off'))).toBe('SETTLEMENT_DISABLED')
    expect((await new SupplierSettlementService(database, owner, {}).list(tenantId, {})).items).toBeDefined()
    const payables = new BookingPayablesService(database, owner)
    const now = new Date()
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000 - 3_600_000)
    const supplier3 = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} Settle LLC`, displayName: 'Settle Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    for (const [label, ago, amount] of [['old', 80, 6_000n], ['new', 5, 4_000n]] as const) {
      const b = await booking(`settle-${label}`, { supplierId: supplier3 })
      const e = await owner.bookingFinanceEvent.create({ data: { tenantId, bookingId: b.id, type: 'CONFIRMED', seq: ++seq, currency: 'AED', sellMinor: sell, paymentMode: 'CREDIT', payload: {}, createdAt: daysAgo(ago) } })
      await owner.supplierPayableEntry.create({ data: { tenantId, bookingId: b.id, supplierId: supplier3, eventId: e.id, kind: 'ACCRUAL', currency: 'AED', amountMinor: amount, createdAt: daysAgo(ago) } })
    }
    const body = (over: Record<string, unknown> = {}) => ({ supplierId: supplier3, currency: 'AED', amountMinor: '4000', paidOn: iso(now), paymentReference: `WIRE-${seq}-${Math.random().toString(36).slice(2, 8)}`, requestId: `req-${Math.random().toString(36).slice(2, 12)}`, ...over })
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as { response?: { code?: string } }).response?.code ?? 'error')

    const first = body({ paymentReference: 'WIRE-A-0001', requestId: 'req-first-0001' })
    const proposed = await settlements.propose(tenantId, actor, first as never, 'rq1')
    expect(proposed).toMatchObject({ status: 'PROPOSED', amountMinor: '4000', supplierName: 'Settle Supplier', proposedById: actor, decidedById: null })
    // idempotent replay returns the same settlement; the same key for different content is refused; a repeated payment reference is refused
    expect((await settlements.propose(tenantId, actor, first as never, 'rq1b')).id).toBe(proposed.id)
    expect(await code(settlements.propose(tenantId, actor, { ...first, amountMinor: '4001' } as never, 'rq1c'))).toBe('SETTLEMENT_IDEMPOTENCY_CONFLICT')
    expect(await code(settlements.propose(tenantId, actor, body({ paymentReference: 'WIRE-A-0001', amountMinor: '100' }) as never, 'rq1d'))).toBe('SETTLEMENT_DUPLICATE_REFERENCE')
    // overpayment guard counts proposals still waiting: 10,000 owed, 4,000 pending, so 6,001 is too much and 6,000 is not
    expect(await code(settlements.propose(tenantId, actor, body({ amountMinor: '6001' }) as never, 'rq2'))).toBe('SETTLEMENT_EXCEEDS_OWED')
    const second = await settlements.propose(tenantId, actor, body({ amountMinor: '6000', paymentReference: 'WIRE-B-0002' }) as never, 'rq3')
    expect(await code(settlements.propose(tenantId, actor, body({ amountMinor: '1' }) as never, 'rq4'))).toBe('SETTLEMENT_EXCEEDS_OWED')
    // other refusals
    expect(await code(settlements.propose(tenantId, actor, body({ supplierId: 'nope' }) as never, 'rq5'))).toBe('SETTLEMENT_UNKNOWN_SUPPLIER')
    expect(await code(settlements.propose(tenantId, actor, body({ currency: 'USD' }) as never, 'rq6'))).toBe('SETTLEMENT_EXCEEDS_OWED')
    expect(await code(settlements.propose(tenantId, actor, body({ paidOn: iso(new Date(now.getTime() + 2 * 86_400_000)) }) as never, 'rq7'))).toBe('SETTLEMENT_INVALID')

    // maker-checker: the proposer cannot approve; a different person can; a decided settlement cannot be decided again
    expect(await code(settlements.approve(tenantId, actor, proposed.id, 'rq8'))).toBe('SETTLEMENT_SELF_APPROVAL')
    const approved = await settlements.approve(tenantId, approver, proposed.id, 'rq9')
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: approver })
    expect(await code(settlements.approve(tenantId, approver, proposed.id, 'rq10'))).toBe('SETTLEMENT_ALREADY_DECIDED')
    expect(await code(settlements.reject(tenantId, approver, proposed.id, { reason: 'too late' }, 'rq11'))).toBe('SETTLEMENT_ALREADY_DECIDED')
    expect(await code(settlements.approve(tenantId, approver, 'missing', 'rq12'))).toBe('SETTLEMENT_NOT_FOUND')
    // rejecting needs a reason, frees the amount, and is final
    expect(await code(settlements.reject(tenantId, approver, second.id, {}, 'rq13'))).toBe('SETTLEMENT_INVALID')
    expect(await settlements.reject(tenantId, approver, second.id, { reason: 'Wrong supplier account' }, 'rq14')).toMatchObject({ status: 'REJECTED', decisionReason: 'Wrong supplier account' })
    expect(await code(settlements.propose(tenantId, actor, body({ amountMinor: '6000', paymentReference: 'WIRE-C-0003' }) as never, 'rq15'))).toBe('ok')

    // audit: one event per step, by the acting user, no free text beyond the reference
    const audits = await owner.auditEvent.findMany({ where: { tenantId, entityType: 'supplier_settlement', entityId: proposed.id }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((a) => [a.action, a.userId, a.actorType])).toEqual([['finance.settlement.proposed', actor, 'USER'], ['finance.settlement.approved', approver, 'USER']])

    // the database enforces it too, even for the owner
    await expect(owner.$executeRawUnsafe(`UPDATE "SupplierSettlement" SET amount_minor = 1 WHERE id = $1`, proposed.id)).rejects.toThrow(/immutable/i)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "SupplierSettlement" WHERE id = $1`, proposed.id)).rejects.toThrow(/never deleted/i)
    const selfApproved = await owner.supplierSettlement.create({ data: { tenantId, supplierId: supplier3, currency: 'AED', amountMinor: 1n, paidOn: now, paymentReference: 'WIRE-SELF-1', requestId: 'req-self-0001', proposedById: actor } })
    await expect(owner.$executeRawUnsafe(`UPDATE "SupplierSettlement" SET status = 'APPROVED', decided_by_id = proposed_by_id, decided_at = now() WHERE id = $1`, selfApproved.id)).rejects.toThrow(/second_person/)
    await owner.$executeRawUnsafe(`UPDATE "SupplierSettlement" SET status = 'REJECTED', decided_by_id = $2, decided_at = now(), decision_reason = 'test cleanup' WHERE id = $1`, selfApproved.id, approver)

    // approved payments reduce what is outstanding, and the aging applies them to the oldest bookings first: 4,000 paid clears 4,000 of the 80-day booking
    const row = (await payables.payables(tenantId)).rows.find((r) => r.supplierId === supplier3)!
    expect(row).toMatchObject({ balanceMinor: '10000', paidMinor: '4000', outstandingMinor: '6000' })
    const aging = (await payables.aging(tenantId, now)).rows.find((r) => r.supplierId === supplier3)!
    expect(aging.buckets.map((b) => [b.bucket, b.amountMinor, b.bookings])).toEqual([['D0_30', '4000', 1], ['D31_60', '0', 0], ['D61_90', '2000', 1], ['D91_PLUS', '0', 0]])
    expect(aging.totalMinor).toBe('6000')

    // listing: filters, newest first, names, tenant isolation, unavailable role
    expect((await settlements.list(tenantId, { status: 'APPROVED', supplierId: supplier3 })).items.map((i) => i.id)).toEqual([proposed.id])
    expect((await settlements.list(tenantId, { supplierId: supplier3 })).items.length).toBeGreaterThanOrEqual(4)
    expect(await code(settlements.list(tenantId, { status: 'WHATEVER' }))).toBe('SETTLEMENT_INVALID')
    expect((await settlements.list(otherTenantId, {})).items).toEqual([])
    expect(await code(new SupplierSettlementService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL }), owner, { SUPPLIER_SETTLEMENT_ENABLED: 'true' }).list(tenantId, {}))).toBe('BOOKING_FINANCE_POSTING_UNAVAILABLE')
  })

  it('TERMS AND DUE DATES: terms are append-only history; due dates follow the basis; approved payments clear the earliest-due bookings first; no terms or no date means no due date, never overdue', async () => {
    const terms = new SupplierTermsService(database, owner, { SUPPLIER_SETTLEMENT_ENABLED: 'true' })
    const settlements = new SupplierSettlementService(database, owner, { SUPPLIER_SETTLEMENT_ENABLED: 'true' })
    const payables = new BookingPayablesService(database, owner)
    const now = new Date()
    const day = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n))
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as { response?: { code?: string } }).response?.code ?? 'error')
    const supplier4 = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} Terms LLC`, displayName: 'Terms Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const supplier5 = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} NoTerms LLC`, displayName: 'No Terms Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const accrue = async (label: string, supplier: string, amount: bigint, checkOut: Date | null) => {
      const b = await booking(`due-${label}`, { supplierId: supplier, ...(checkOut ? { checkIn: new Date(checkOut.getTime() - 2 * 86_400_000), checkOut } : {}) })
      const e = await fact(b.id, 'CONFIRMED')
      await owner.supplierPayableEntry.create({ data: { tenantId, bookingId: b.id, supplierId: supplier, eventId: e.id, kind: 'ACCRUAL', currency: 'AED', amountMinor: amount } })
    }
    await accrue('a', supplier4, 5_000n, day(-100))   // due 70 days ago
    await accrue('b', supplier4, 3_000n, day(-40))    // due 10 days ago
    await accrue('c', supplier4, 2_000n, day(-10))    // due in 20 days
    await accrue('d', supplier4, 1_000n, null)        // no stay dates: no due date
    await accrue('e', supplier5, 700n, day(-100))     // no terms at all
    const cells = (rows: Awaited<ReturnType<BookingPayablesService['due']>>['rows'], supplierId: string) => Object.fromEntries(rows.find((r) => r.supplierId === supplierId)!.buckets.filter((b) => b.bookings > 0).map((b) => [b.bucket, b.amountMinor]))

    // No terms yet: nothing is overdue
    const none = await payables.due(tenantId, now)
    expect(cells(none.rows, supplier4)).toEqual({ NO_DUE_DATE: '11000' })
    expect(none.rows.find((r) => r.supplierId === supplier4)).toMatchObject({ basis: null, days: null, overdueMinor: '0' })

    // Terms: refused without the switch, validated, set, idempotent, history kept
    expect(await code(new SupplierTermsService(database, owner, {}).set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_OUT', days: 30 }, 'rq'))).toBe('TERMS_DISABLED')
    expect(await code(terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_OUT', days: -3 } as never, 'rq'))).toBe('TERMS_INVALID')
    expect(await code(terms.set(tenantId, actor, { supplierId: 'nope', basis: 'CHECK_OUT', days: 30 }, 'rq'))).toBe('TERMS_UNKNOWN_SUPPLIER')
    expect(await terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_OUT', days: 30, note: 'Net 30 per contract' }, 'rq1')).toMatchObject({ basis: 'CHECK_OUT', days: 30, note: 'Net 30 per contract', setById: actor })
    await terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_OUT', days: 30, note: 'Net 30 per contract' }, 'rq1b')
    expect(await owner.supplierPaymentTerms.count({ where: { tenantId, supplierId: supplier4 } })).toBe(1)

    const due30 = await payables.due(tenantId, now)
    expect(cells(due30.rows, supplier4)).toEqual({ OVERDUE_61_90: '5000', OVERDUE_1_30: '3000', NOT_DUE: '2000', NO_DUE_DATE: '1000' })
    expect(due30.rows.find((r) => r.supplierId === supplier4)).toMatchObject({ basis: 'CHECK_OUT', days: 30, overdueMinor: '8000', totalMinor: '11000', bookings: 4 })
    expect(cells(due30.rows, supplier5)).toEqual({ NO_DUE_DATE: '700' })

    // An approved payment clears the earliest-due booking first (the 70-days-overdue one)
    const paid = await settlements.propose(tenantId, actor, { supplierId: supplier4, currency: 'AED', amountMinor: '5000', paidOn: now.toISOString().slice(0, 10), paymentReference: 'WIRE-TERMS-1', requestId: 'req-terms-0001' }, 'rq2')
    await settlements.approve(tenantId, approver, paid.id, 'rq3')
    expect(cells((await payables.due(tenantId, now)).rows, supplier4)).toEqual({ OVERDUE_1_30: '3000', NOT_DUE: '2000', NO_DUE_DATE: '1000' })

    // Longer terms move due dates: 45 days makes the 40-days-after-check-out booking not yet due; the old terms stay as history
    await terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_OUT', days: 45 }, 'rq4')
    expect(await owner.supplierPaymentTerms.count({ where: { tenantId, supplierId: supplier4 } })).toBe(2)
    expect(cells((await payables.due(tenantId, now)).rows, supplier4)).toEqual({ NOT_DUE: '5000', NO_DUE_DATE: '1000' })
    const listed = (await terms.list(tenantId)).items
    expect(listed.find((i) => i.supplierId === supplier4)).toMatchObject({ basis: 'CHECK_OUT', days: 45, name: 'Terms Supplier', owed: [{ currency: 'AED', outstandingMinor: '6000' }] })
    expect(listed.find((i) => i.supplierId === supplier5)).toMatchObject({ basis: null, days: null, owed: [{ currency: 'AED', outstandingMinor: '700' }] })
    const audits = await owner.auditEvent.findMany({ where: { tenantId, action: 'finance.supplier_terms.set', entityId: supplier4 }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((a) => (a.payload as { days: number; previousDays: number | null }))).toEqual([expect.objectContaining({ days: 30, previousDays: null }), expect.objectContaining({ days: 45, previousDays: 30 })])

    // The confirmation basis counts from when the booking was accrued; the check-in basis from the check-in date
    await terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CONFIRMATION', days: 0 }, 'rq5')
    expect(cells((await payables.due(tenantId, now)).rows, supplier4)).toEqual({ NOT_DUE: '6000' })   // accrued today, due today: not yet overdue, and it needs no stay date
    await terms.set(tenantId, actor, { supplierId: supplier4, basis: 'CHECK_IN', days: 0 }, 'rq6')
    expect(cells((await payables.due(tenantId, now)).rows, supplier4)).toEqual({ OVERDUE_31_60: '3000', OVERDUE_1_30: '2000', NO_DUE_DATE: '1000' })   // check-in was 42 and 12 days ago

    // History cannot be edited, even by the owner; tenants are isolated; an unavailable role is the typed 503
    const row = await owner.supplierPaymentTerms.findFirstOrThrow({ where: { tenantId, supplierId: supplier4 } })
    await expect(owner.$executeRawUnsafe(`UPDATE "SupplierPaymentTerms" SET days = 1 WHERE id = $1`, row.id)).rejects.toThrow(/append-only/i)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "SupplierPaymentTerms" WHERE id = $1`, row.id)).rejects.toThrow(/append-only/i)
    expect((await terms.list(otherTenantId)).items).toEqual([])
    expect((await payables.due(otherTenantId, now)).rows).toEqual([])
    expect(await code(new SupplierTermsService(new BookingFinancePostingDatabase({ DATABASE_URL: process.env.DATABASE_URL }), owner).list(tenantId))).toBe('BOOKING_FINANCE_POSTING_UNAVAILABLE')
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
