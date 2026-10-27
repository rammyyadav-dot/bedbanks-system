import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../src/agent/supplier-mutation-journal.service'
import { BookingReconciliationService } from '../src/agent/booking-reconciliation.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { SupplierProviderError, type SupplierAdapter } from '../src/agent/supplier.port'
import { OperationsLedgerIntegrityService } from '../src/admin-operations/operations-ledger-integrity.service'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'
import { eraseLedger } from './ledger-erasure'

/**
 * Finance proof: failed and duplicate bookings never leave an incorrect financial entry.
 * Every scenario drives the real services against PostgreSQL, then asserts (a) the exact ledger entries, (b) that nothing was posted
 * to the finance sub-ledgers (posting events, supplier payables, documents), and (c) that the ledger integrity reconciliation
 * (ADR 0068, R1 to R4) reports no critical finding and rolls the balance forward to the sum of the entries.
 */
describe('failed and duplicate bookings leave no incorrect financial entry (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const reconciliation = new BookingReconciliationService(prisma, finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const journal = new SupplierMutationJournalService(prisma, audit)
  const integrity = new OperationsLedgerIntegrityService(prisma)
  const suffix = `failproof-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nights = [new Date('2099-04-01'), new Date('2099-04-02')]
  const SELL = 125099n
  const LINE = 3_000_000n // credit line: room for the scenarios below; CREDIT-1 then narrows it to the minor unit
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string, walletId: string, agencyId: string

  type Outcome = 'ok' | 'reject' | 'timeout'
  let supplierCalls = 0
  const supplier = (outcome: Outcome): SupplierAdapter => ({
    prebook: async () => {
      supplierCalls += 1
      if (outcome === 'reject') throw new SupplierProviderError('malformed_response')
      if (outcome === 'timeout') throw new SupplierProviderError('timeout')
      return { supplierReference: 'contracted:proof' }
    },
  }) as unknown as SupplierAdapter
  const flow = (outcome: Outcome) => {
    const orchestration = new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, journal, supplier(outcome))
    return new BookingTransactionService(prisma, orchestration, confirmation)
  }
  const prebook = (outcome: Outcome, key: string, holdId: string) =>
    flow(outcome).prebook({ tenantId, userId, requestId: `${key}-req`, inventoryHoldId: holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Test', lastName: 'Guest' } })
  const newHold = (key: string) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-04-01', checkOut: '2099-04-03', rooms: 1, currency: 'AED', sellAmountMinor: Number(SELL), offerExpiresAt: '2099-04-01T12:00:00.000Z' })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const ledgerRows = () => prisma.ledgerEntry.count({ where: { walletId } })
  const entriesFor = async (bookingId: string) => (await prisma.ledgerEntry.findMany({ where: { walletId, reference: `booking:${bookingId}` }, orderBy: { immutableAt: 'asc' }, select: { type: true, amountMinor: true } }))
    .map((e) => `${e.type}:${e.amountMinor}`)
  const bookingFor = (key: string) => prisma.booking.findMany({ where: { tenantId, idempotencyKey: key } })
  const subLedgerRows = async (bookingId: string) => ({
    events: await prisma.bookingFinanceEvent.count({ where: { tenantId, bookingId } }),
    postings: await prisma.bookingFinancePosting.count({ where: { tenantId, bookingId } }),
    payables: await prisma.supplierPayableEntry.count({ where: { tenantId, bookingId } }),
    documents: await prisma.bookingDocument.count({ where: { tenantId, bookingId } }),
    creditNotes: await prisma.bookingCreditNote.count({ where: { tenantId, bookingId } }),
  })
  const NONE = { events: 0, postings: 0, payables: 0, documents: 0, creditNotes: 0 }
  const report = () => integrity.report(tenantId, {})
  const criticalFindings = async () => (await report()).findings.filter((f) => f.severity === 'critical').map((f) => `${f.code}:${f.bookingId ?? ''}`)

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 50 })) })
    const booker = await makeAgencyBooker(prisma, tenantId, userId, LINE)
    walletId = booker.walletId
    agencyId = booker.agencyId
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await eraseLedger(prisma, { where: { tenantId } })
    await prisma.supplierMutation.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await removeAgencyBookers(prisma, tenantId)
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId } })
    await prisma.ratePlan.delete({ where: { id: ratePlanId } })
    await prisma.contract.delete({ where: { id: contractId } })
    await prisma.boardBasis.delete({ where: { id: boardId } })
    await prisma.roomType.delete({ where: { id: roomId } })
    await prisma.hotel.delete({ where: { id: hotelId } })
    await prisma.supplier.delete({ where: { id: supplierId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('FAIL-1 a definitive supplier rejection nets the account to zero: HOLD then RELEASE, no charge, no posting, no payable, no document', async () => {
    const key = `${suffix}-reject`
    const hold = await newHold(key)
    const before = await walletNet()
    await expect(prebook('reject', key, hold.holdId)).rejects.toThrow('Supplier prebook unavailable')
    const [booking] = await bookingFor(key)
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`, `RELEASE:${SELL}`])
    expect(await walletNet()).toBe(before)
    expect(await subLedgerRows(booking!.id)).toEqual(NONE)
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' })
    // A second attempt after the failure is a distinct, failed attempt and must not double-release or charge.
    await expect(prebook('reject', key, hold.holdId)).rejects.toThrow()
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`, `RELEASE:${SELL}`])
    expect(await walletNet()).toBe(before)
    expect(await criticalFindings()).toEqual([])
  })

  it('FAIL-2 an unobserved supplier outcome keeps the reservation (never a charge, never a release), flags it, and a retry does not reserve twice', async () => {
    const key = `${suffix}-timeout`
    const hold = await newHold(key)
    const before = await walletNet()
    await expect(prebook('timeout', key, hold.holdId)).rejects.toThrow('outcome is unknown')
    const [booking] = await bookingFor(key)
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`])
    expect(await walletNet()).toBe(before - SELL)
    const calls = supplierCalls
    await expect(prebook('timeout', key, hold.holdId)).rejects.toThrow('outcome is unknown')
    expect(supplierCalls).toBe(calls) // the supplier is not asked again
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`])
    expect(await subLedgerRows(booking!.id)).toEqual(NONE)
    await expect(confirmation.confirm({ tenantId, userId, requestId: 'x', bookingId: booking!.id })).rejects.toThrow()
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`])
    // Stale and still unresolved: reconciliation sends it to a person; it neither releases nor charges.
    await prisma.$executeRawUnsafe(`UPDATE "InventoryHold" SET "updated_at" = now() - interval '90 minutes' WHERE id = '${hold.holdId}'`)
    await reconciliation.reconcileStale({ tenantId, userId, requestId: `${suffix}-r1` })
    await reconciliation.reconcileStale({ tenantId, userId, requestId: `${suffix}-r2` })
    expect(await entriesFor(booking!.id)).toEqual([`HOLD:-${SELL}`])
    // The integrity reconciliation surfaces it as an open reservation (timing), never as a critical break.
    expect(await criticalFindings()).toEqual([])
    integrity.clock = () => new Date(Date.now() + 2 * 3_600_000) // two hours on, the reservation is stale
    try {
      const stale = (await report()).findings.filter((f) => f.bookingId === booking!.id)
      expect(stale.length).toBeGreaterThan(0)
      expect(stale.every((f) => f.severity === 'warning')).toBe(true)
    } finally { integrity.clock = () => new Date() }
  })

  it('DUP-1 the same idempotency key sequentially reserves once and returns the same booking', async () => {
    const key = `${suffix}-dup-seq`
    const hold = await newHold(key)
    const before = await walletNet()
    const first = await prebook('ok', key, hold.holdId)
    const again = await prebook('ok', key, hold.holdId)
    expect(again.bookingId).toBe(first.bookingId)
    expect(await bookingFor(key)).toHaveLength(1)
    expect(await entriesFor(first.bookingId)).toEqual([`HOLD:-${SELL}`])
    expect(await walletNet()).toBe(before - SELL)
    // Settle it, then replay both steps: still one DEBIT.
    await confirmation.confirm({ tenantId, userId, requestId: 'c1', bookingId: first.bookingId })
    await confirmation.confirm({ tenantId, userId, requestId: 'c2', bookingId: first.bookingId })
    await prebook('ok', key, hold.holdId).catch(() => undefined)
    expect(await entriesFor(first.bookingId)).toEqual([`HOLD:-${SELL}`, `RELEASE:${SELL}`, `DEBIT:-${SELL}`])
    expect(await walletNet()).toBe(before - SELL)
    expect(await criticalFindings()).toEqual([])
  })

  it('DUP-2 ten simultaneous prebooks with one key produce one booking and one reservation', async () => {
    const key = `${suffix}-dup-par`
    const hold = await newHold(key)
    const before = await walletNet()
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => prebook('ok', key, hold.holdId)))
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof prebook>>> => r.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ok.map((r) => r.value.bookingId)).size).toBe(1)
    const bookings = await bookingFor(key)
    expect(bookings).toHaveLength(1)
    expect(await entriesFor(bookings[0]!.id)).toEqual([`HOLD:-${SELL}`])
    expect(await walletNet()).toBe(before - SELL)
    expect(await criticalFindings()).toEqual([])
    await confirmation.confirm({ tenantId, userId, requestId: 'dup-par', bookingId: bookings[0]!.id })
    expect(await walletNet()).toBe(before - SELL)
  })

  it('DUP-3 one key reused for a different hold is refused and moves no money', async () => {
    const key = `${suffix}-dup-diff`
    const holdA = await newHold(`${key}-a`)
    const before = await walletNet()
    const first = await prebook('ok', key, holdA.holdId)
    const net = await walletNet()
    expect(net).toBe(before - SELL)
    const holdB = await newHold(`${key}-b`)
    await expect(prebook('ok', key, holdB.holdId)).rejects.toThrow()
    expect(await walletNet()).toBe(net)
    expect(await bookingFor(key)).toHaveLength(1)
    expect(await entriesFor(first.bookingId)).toEqual([`HOLD:-${SELL}`])
    await holds.release(tenantId, holdB.holdId, 'cleanup', { type: 'USER', userId })
    await confirmation.confirm({ tenantId, userId, requestId: 'dup-diff', bookingId: first.bookingId })
  })

  it('CREDIT-1 a booking beyond the approved line is refused with no entry; an exact fit passes; concurrent bookings cannot both take the last credit; the early hold check refuses too', async () => {
    // Holds are made while credit is ample, then the line is narrowed so only the binding prebook check stands in the way.
    const shortHold = await newHold(`${suffix}-short`)
    const fitHold = await newHold(`${suffix}-fit`)
    const racedHolds = await Promise.all(Array.from({ length: 5 }, (_, i) => newHold(`${suffix}-race-${i}`)))
    const pair = await Promise.all([newHold(`${suffix}-pair-0`), newHold(`${suffix}-pair-1`)])
    const net = await walletNet()
    expect(LINE + net).toBeGreaterThan(SELL * 9n)
    /** Sets the credit the binding check sees: balance + line = target, from the ledger as it stands now. */
    const setAvailable = async (target: bigint) => { await prisma.agencyCreditLimit.updateMany({ where: { tenantId, agencyId }, data: { limitMinor: target - (await walletNet()) } }) }

    await setAvailable(SELL - 1n) // one minor unit short
    const rows = await ledgerRows()
    await expect(prebook('ok', `${suffix}-short`, shortHold.holdId)).rejects.toThrow('Insufficient wallet credit')
    expect(await ledgerRows()).toBe(rows) // no HOLD, no RELEASE, nothing
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: shortHold.holdId } })).toMatchObject({ status: 'RELEASED' })
    const refused = (await bookingFor(`${suffix}-short`))[0]
    if (refused) expect(await entriesFor(refused.id)).toEqual([])
    // The early check at hold time refuses as well, again with nothing posted.
    await expect(newHold(`${suffix}-early`)).rejects.toMatchObject({ response: { code: 'AGENCY_CREDIT_LIMIT_EXCEEDED' } })
    expect(await ledgerRows()).toBe(rows)

    await setAvailable(SELL) // exactly the price: fits to the minor unit
    await expect(prebook('ok', `${suffix}-fit`, fitHold.holdId)).resolves.toMatchObject({ status: 'prebooked' })
    expect(await walletNet()).toBe(net - SELL)
    const afterFit = await walletNet()

    // Credit is now exactly exhausted: five concurrent bookings are all refused and none leaves an entry.
    const raced = await Promise.allSettled(racedHolds.map((h, i) => prebook('ok', `${suffix}-race-${i}`, h.holdId)))
    expect(raced.every((r) => r.status === 'rejected')).toBe(true)
    expect(await walletNet()).toBe(afterFit)
    expect(await criticalFindings()).toEqual([])

    // Two bookings racing for credit that covers only one: exactly one reserves.
    const pairNet = await walletNet()
    await setAvailable(SELL) // credit for exactly one of the two
    const duel = await Promise.allSettled(pair.map((h, i) => prebook('ok', `${suffix}-pair-${i}`, h.holdId)))
    expect(duel.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await walletNet()).toBe(pairNet - SELL)
  })

  it('ROLL-FORWARD the integrity run balances: reservations from the failed and open attempts are explained, the balance equals the entries, nothing is critical', async () => {
    const result = await report()
    expect(result.scan.capped).toBe(false)
    expect(result.counts.byCode.filter((c) => c.severity === 'critical')).toEqual([])
    expect(result.verdict).not.toBe('ISSUES')
    expect(result.totals.map((t) => t.currency)).toEqual(['AED'])
    const aed = result.totals[0]!
    expect(BigInt(aed.balanceMinor)).toBe(await walletNet())
    expect(BigInt(aed.balanceMinor)).toBe(BigInt(aed.fundingCreditsMinor) + BigInt(aed.otherCreditsMinor) + BigInt(aed.refundsMinor) - BigInt(aed.chargesMinor) - BigInt(aed.openReservationsMinor))
    // Only CONFIRMED bookings are charges; the two unresolved/exhausted attempts are the only open reservations (the timeout, plus the exact fit).
    const confirmed = await prisma.booking.count({ where: { tenantId, status: 'CONFIRMED' } })
    expect(BigInt(aed.chargesMinor)).toBe(SELL * BigInt(confirmed))
    // No failed booking ever reached a financial sub-ledger.
    const failed = await prisma.booking.findMany({ where: { tenantId, status: { in: ['FAILED', 'PENDING_SUPPLIER'] } }, select: { id: true } })
    for (const b of failed) expect(await subLedgerRows(b.id)).toEqual(NONE)
    // Every DEBIT belongs to a CONFIRMED booking.
    const debits = await prisma.ledgerEntry.findMany({ where: { walletId, type: 'DEBIT' }, select: { reference: true } })
    for (const d of debits) {
      const id = d.reference!.replace('booking:', '')
      expect(await prisma.booking.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CONFIRMED' })
    }
  })
})
