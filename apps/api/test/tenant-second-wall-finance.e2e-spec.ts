import { randomBytes } from 'crypto'
import { HttpException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../src/agent/supplier-mutation-journal.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { BookingCancellationService } from '../src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../src/agent/cancellation-policy.service'
import { LedgerService } from '../src/agent/ledger.service'
import { FundingService } from '../src/funding/funding.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'
import { eraseLedger } from './ledger-erasure'

// Launch policy (ADR 0029): AED only.
process.env.SETTLEMENT_CURRENCIES = 'AED'

jest.setTimeout(120_000)

/**
 * ADR 0071, financial paths: the second wall with RLS out of the picture. The services run on the schema-owner connection, where RLS does not
 * apply, as a tenant-A actor against tenant-B booking, hold, wallet and funding ids. Every refusal is paired with a positive control on tenant A's
 * own data, and each attack asserts that tenant B's booking, hold, inventory, ledger and receipt are exactly as they were.
 */
describe('tenant second wall, financial paths: confirm, cancel and fund refuse another tenant with RLS out of the picture (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const cancellations = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
  const journal = new SupplierMutationJournalService(prisma, audit)
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, journal, supplier), confirmation)
  const funding = new FundingService(prisma, new AgentAuditService(prisma))
  const suffix = `swf-${Date.now()}-${randomBytes(3).toString('hex')}`
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  const guest = { firstName: 'Test', lastName: 'Guest' }
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  let n = 0

  type World = { label: string; tenantId: string; userId: string; reviewerId: string; supplierId: string; hotelId: string; roomId: string; boardId: string; contractId: string; ratePlanId: string; agencyId: string; walletId: string }

  async function world(label: string): Promise<World> {
    const key = `${suffix}-${label}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    const userId = (await prisma.user.create({ data: { email: `${key}@example.test` } })).id
    const reviewerId = (await prisma.user.create({ data: { email: `${key}-reviewer@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    await prisma.membership.create({ data: { tenantId, userId: reviewerId, role: 'owner' } })
    const supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${key} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${key} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    const roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: key.slice(-30), maxAdults: 2, maxOccupancy: 2 } })).id
    const boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    const contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: key, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    const ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: key.slice(-30), status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 20 })) })
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 3, penaltyPercent: 100 } }) // a penalty only inside 3 days of check-in; 2099 is far away
    const booker = await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n)
    return { label, tenantId, userId, reviewerId, supplierId, hotelId, roomId, boardId, contractId, ratePlanId, agencyId: booker.agencyId, walletId: booker.walletId }
  }

  const hold = (w: World, key: string) => holds.create({ tenantId: w.tenantId, userId: w.userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId: w.ratePlanId,
    canonicalHotelId: w.hotelId, canonicalRoomTypeId: w.roomId, boardBasisId: w.boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z' })
  const prebook = async (w: World, key: string) => {
    const h = await hold(w, key)
    const pre = await tx.prebook({ tenantId: w.tenantId, userId: w.userId, requestId: `${key}-req`, inventoryHoldId: h.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
    return { bookingId: pre.bookingId, holdId: h.holdId }
  }
  const confirm = (actor: World, bookingId: string) => tx.confirm({ tenantId: actor.tenantId, userId: actor.userId, requestId: `confirm-${Math.random()}`, bookingId })
  const cancel = (actor: World, bookingId: string) => cancellations.cancel({ tenantId: actor.tenantId, userId: actor.userId, requestId: `cancel-${Math.random()}`, bookingId, reason: 'guest request' })

  /** Everything a cross-tenant call could disturb in one tenant, for an exact before/after comparison. */
  const snapshot = async (w: World) => ({
    bookings: await prisma.booking.findMany({ where: { tenantId: w.tenantId }, orderBy: { id: 'asc' }, select: { id: true, status: true, supplier: true, updatedAt: true } }),
    holds: await prisma.inventoryHold.findMany({ where: { tenantId: w.tenantId }, orderBy: { id: 'asc' }, select: { id: true, status: true, releasedAt: true } }),
    availability: await prisma.dailyAvailability.findMany({ where: { ratePlanId: w.ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true, sold: true } }),
    ledger: await prisma.ledgerEntry.findMany({ where: { tenantId: w.tenantId }, orderBy: { id: 'asc' }, select: { id: true, type: true, amountMinor: true } }),
    cancellations: await prisma.cancellation.count({ where: { booking: { tenantId: w.tenantId } } }),
    receipts: await prisma.fundingReceipt.findMany({ where: { tenantId: w.tenantId }, orderBy: { id: 'asc' }, select: { id: true, status: true, verifiedById: true, rejectedById: true, postedById: true } }),
    audit: await prisma.auditEvent.count({ where: { tenantId: w.tenantId } }),
  })

  // A deliberate refusal (404/403/409), never a crash or a database error that merely happens to throw.
  let A: World, B: World

  beforeAll(async () => {
    await prisma.$connect()
    process.env.FUNDING_ENABLED = 'true'
    A = await world('a'); B = await world('b')
  })

  afterAll(async () => {
    for (const w of [A, B].filter(Boolean)) {
      await prisma.fundingReceipt.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.auditEvent.deleteMany({ where: { tenantId: w.tenantId } })
      await eraseLedger(prisma, { where: { tenantId: w.tenantId } })
      await prisma.supplierMutation.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.booking.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.inventoryHoldNight.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.inventoryHold.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId: w.tenantId } })
      await removeAgencyBookers(prisma, w.tenantId)
      await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: w.ratePlanId } })
      await prisma.cancellationPolicy.deleteMany({ where: { contractId: w.contractId } })
      await prisma.ratePlan.delete({ where: { id: w.ratePlanId } })
      await prisma.contract.delete({ where: { id: w.contractId } })
      await prisma.boardBasis.delete({ where: { id: w.boardId } })
      await prisma.roomType.delete({ where: { id: w.roomId } })
      await prisma.hotel.delete({ where: { id: w.hotelId } })
      await prisma.supplier.delete({ where: { id: w.supplierId } })
      await prisma.membership.deleteMany({ where: { tenantId: w.tenantId } })
      await prisma.user.deleteMany({ where: { id: { in: [w.userId, w.reviewerId] } } })
      await prisma.tenant.delete({ where: { id: w.tenantId } })
    }
    await prisma.$disconnect()
  })

  it('control: the connection bypasses RLS, so only the services stand between the tenants', async () => {
    const [role] = await prisma.$queryRaw<Array<{ bypass: boolean }>>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(role.bypass).toBe(true)
    const seen = await prisma.withTenant(A.tenantId, (t) => t.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Hotel" WHERE "id" IN (${A.hotelId}, ${B.hotelId})`)
    expect(seen.map((r) => r.id).sort()).toEqual([A.hotelId, B.hotelId].sort())
  })

  it('confirming another tenant\'s booking is refused and moves nothing: no sale, no charge, no hold change, no audit', async () => {
    // Positive control: tenant A confirms its own prebooked booking.
    const own = await prebook(A, `${suffix}-a-confirm`)
    expect(await confirm(A, own.bookingId)).toMatchObject({ bookingId: own.bookingId, status: 'CONFIRMED', alreadyConfirmed: false })

    const victim = await prebook(B, `${suffix}-b-confirm`)
    const before = await snapshot(B)
    await expect(confirm(A, victim.bookingId)).rejects.toBeInstanceOf(HttpException)
    expect(await snapshot(B)).toEqual(before)
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: victim.bookingId } })).toMatchObject({ status: 'PENDING_SUPPLIER' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: victim.holdId } })).toMatchObject({ status: 'PROCESSING' })

    // And B can still confirm it itself: the refusal was tenancy, not a broken booking.
    expect(await confirm(B, victim.bookingId)).toMatchObject({ status: 'CONFIRMED' })
  })

  it('quoting or cancelling another tenant\'s confirmed booking is refused and refunds nothing', async () => {
    // Positive control: tenant A quotes and cancels its own confirmed booking.
    const own = await prebook(A, `${suffix}-a-cancel`); await confirm(A, own.bookingId)
    expect(await cancellations.quote({ tenantId: A.tenantId, userId: A.userId, requestId: 'q', bookingId: own.bookingId })).toMatchObject({ refundMinor: '125099' })
    expect(await cancel(A, own.bookingId)).toMatchObject({ status: 'CANCELLED', refundMinor: '125099' })

    const victim = await prebook(B, `${suffix}-b-cancel`); await confirm(B, victim.bookingId)
    const before = await snapshot(B)
    await expect(cancellations.quote({ tenantId: A.tenantId, userId: A.userId, requestId: 'q', bookingId: victim.bookingId })).rejects.toBeInstanceOf(HttpException)
    await expect(cancel(A, victim.bookingId)).rejects.toBeInstanceOf(HttpException)
    expect(await snapshot(B)).toEqual(before)
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: victim.bookingId } })).toMatchObject({ status: 'CONFIRMED' })
    expect(await prisma.ledgerEntry.count({ where: { reference: `booking:${victim.bookingId}`, type: 'REFUND' } })).toBe(0)
  })

  it('financial authorization against another tenant\'s wallet is refused and writes nothing into it', async () => {
    const key = `${suffix}-auth`
    const command = (w: World, walletId: string) => ({ tenantId: w.tenantId, userId: w.userId, requestId: `${key}-req`, bookingId: `${key}-booking`, walletId, currency: 'AED', amountMinor: 1_000n, idempotencyKey: key })
    // Positive control: tenant A authorizes against its own wallet, then releases it.
    await finance.authorize(command(A, A.walletId))
    await finance.release(command(A, A.walletId))
    expect(await prisma.ledgerEntry.count({ where: { walletId: A.walletId, idempotencyKey: { startsWith: key } } })).toBe(2)

    const before = await snapshot(B)
    await expect(finance.authorize(command(A, B.walletId))).rejects.toBeInstanceOf(HttpException)
    await expect(finance.release(command(A, B.walletId))).rejects.toBeInstanceOf(HttpException)
    expect(await snapshot(B)).toEqual(before)
  })

  it('a funding receipt of another tenant cannot be read, verified, rejected, cleared or posted', async () => {
    const declare = (w: World) => funding.adminDeclare(w.tenantId, w.userId, { currency: 'AED', amountMinor: '500000', method: 'BANK_TRANSFER', bankReference: `${suffix}-ref-${++n}`, valueDate: yesterday,
      payerName: 'Gulf Travel LLC', payerType: 'AGENCY', requestId: `${suffix}-fr-${n}`, agencyId: w.agencyId })
    // Positive control: tenant A's reviewer verifies tenant A's own receipt.
    const own = await declare(A)
    expect((await funding.verify(A.tenantId, A.reviewerId, own.id, { note: 'matched statement line' })).status).toBe('VERIFIED')

    const victim = await declare(B)
    const before = await snapshot(B)
    await expect(funding.get(A.tenantId, A.reviewerId, victim.id)).rejects.toBeInstanceOf(HttpException)
    await expect(funding.verify(A.tenantId, A.reviewerId, victim.id, { note: 'hijack' })).rejects.toBeInstanceOf(HttpException)
    await expect(funding.clearCompliance(A.tenantId, A.reviewerId, victim.id, { note: 'hijack' })).rejects.toBeInstanceOf(HttpException)
    await expect(funding.reject(A.tenantId, A.reviewerId, victim.id, { reason: 'hijack' })).rejects.toBeInstanceOf(HttpException)
    await expect(funding.post(A.tenantId, A.reviewerId, victim.id)).rejects.toBeInstanceOf(HttpException)
    expect(await snapshot(B)).toEqual(before)
    expect(await prisma.fundingReceipt.findUniqueOrThrow({ where: { id: victim.id } })).toMatchObject({ status: 'DECLARED', verifiedById: null, rejectedById: null, postedById: null })
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: `funding:${victim.id}` } })).toBe(0)
  })
})
