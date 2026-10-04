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
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'

describe('booking cancellation and refunds (PostgreSQL)', () => {
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
  const suffix = `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string, walletId: string

  const newHold = (key: string) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z' })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n

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
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 5 })) })
    walletId = (await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n)).walletId // ADR 0028 slice 3: the booker's agency account
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
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

  const guest = { firstName: 'Test', lastName: 'Guest' }
  const bookConfirmed = async (key: string) => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 20 } })
    const hold = await newHold(key)
    const pre = await tx.prebook({ tenantId, userId, requestId: `${key}-req`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
    await tx.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: pre.bookingId })
    return { bookingId: pre.bookingId, holdId: hold.holdId }
  }
  const cancel = (bookingId: string, extra: object = {}) => cancellations.cancel({ tenantId, userId, requestId: `cancel-${Math.random()}`, bookingId, reason: 'guest request', ...extra })
  const sold = () => prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true, sold: true } })
  const types = (bookingId: string) => prisma.ledgerEntry.findMany({ where: { walletId, reference: `booking:${bookingId}` }, orderBy: { immutableAt: 'asc' }, select: { type: true, amountMinor: true } })
  const setPolicy = async (rules: Array<{ daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: bigint; currency?: string }>) => {
    await prisma.cancellationPolicy.deleteMany({ where: { contractId } })
    for (const rule of rules) await prisma.cancellationPolicy.create({ data: { contractId, ...rule } })
  }

  it('no penalty window: refunds the whole charge, returns inventory, and is idempotent', async () => {
    await setPolicy([{ daysBeforeCheckin: 3, penaltyPercent: 100 }]) // penalty only inside 3 days of check-in (2099 is far away)
    const { bookingId, holdId } = await bookConfirmed(`${suffix}-free`)
    const before = await sold()
    expect(before.every((night) => night.sold >= 1)).toBe(true)
    const net = await walletNet()
    expect(await cancellations.quote({ tenantId, userId, requestId: 'q', bookingId })).toMatchObject({ penaltyMinor: '0', refundMinor: '125099' })

    const result = await cancel(bookingId)
    expect(result).toMatchObject({ status: 'CANCELLED', alreadyCancelled: false, penaltyMinor: '0', refundMinor: '125099', totalMinor: '125099', currency: 'AED' })
    expect(await types(bookingId)).toEqual([{ type: 'HOLD', amountMinor: -125099n }, { type: 'RELEASE', amountMinor: 125099n }, { type: 'DEBIT', amountMinor: -125099n }, { type: 'REFUND', amountMinor: 125099n }])
    expect(await walletNet()).toBe(net + 125099n)
    expect((await sold()).map((night) => night.sold)).toEqual(before.map((night) => night.sold - 1))
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({ status: 'RELEASED' })
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.cancellation.findUniqueOrThrow({ where: { bookingId } })).toMatchObject({ refundMinor: 125099n, reason: 'guest request' })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.cancelled', entityId: bookingId, userId } })).toBe(1)

    expect(await cancel(bookingId)).toMatchObject({ status: 'CANCELLED', alreadyCancelled: true, refundMinor: '125099', cancellationId: result.cancellationId })
    expect((await types(bookingId)).length).toBe(4)
    expect(await walletNet()).toBe(net + 125099n)
  })

  it('applies the contract penalty with integer arithmetic and refunds only the rest', async () => {
    await setPolicy([{ daysBeforeCheckin: 50_000, penaltyPercent: 30 }]) // a rule that always applies
    const { bookingId } = await bookConfirmed(`${suffix}-penalty`)
    const net = await walletNet()
    const result = await cancel(bookingId)
    expect(result).toMatchObject({ penaltyMinor: '37529', refundMinor: '87570' }) // floor(125099*30/100)=37529; 125099-37529=87570
    expect(BigInt(result.penaltyMinor) + BigInt(result.refundMinor)).toBe(125099n)
    expect(await walletNet()).toBe(net + 87570n)
    expect((await types(bookingId)).filter((entry) => entry.type === 'REFUND')).toEqual([{ type: 'REFUND', amountMinor: 87570n }])

    await setPolicy([{ daysBeforeCheckin: 50_000, penaltyMinor: 20_000n, currency: 'AED' }])
    const fixed = await bookConfirmed(`${suffix}-fixed`)
    expect(await cancel(fixed.bookingId)).toMatchObject({ penaltyMinor: '20000', refundMinor: '105099' })
    await setPolicy([{ daysBeforeCheckin: 50_000, penaltyPercent: 100 }])
    const total = await bookConfirmed(`${suffix}-total`)
    const net2 = await walletNet()
    expect(await cancel(total.bookingId)).toMatchObject({ penaltyMinor: '125099', refundMinor: '0' })
    expect(await walletNet()).toBe(net2) // non-refundable: no REFUND entry at all
    expect((await types(total.bookingId)).some((entry) => entry.type === 'REFUND')).toBe(false)
  })

  it('converges 25 simultaneous cancellations on one refund', async () => {
    await setPolicy([{ daysBeforeCheckin: 3, penaltyPercent: 100 }])
    const { bookingId } = await bookConfirmed(`${suffix}-race`)
    const net = await walletNet(), before = await sold()
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => cancel(bookingId)))
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(results.filter((result) => result.status === 'fulfilled' && !result.value.alreadyCancelled)).toHaveLength(1)
    expect((await types(bookingId)).filter((entry) => entry.type === 'REFUND')).toHaveLength(1)
    expect(await walletNet()).toBe(net + 125099n)
    expect((await sold()).map((night) => night.sold)).toEqual(before.map((night) => night.sold - 1))
    expect(await prisma.cancellation.count({ where: { bookingId } })).toBe(1)
  })

  it('fails closed without changing anything: no policy, started stay, unconfirmed booking, unknown or foreign booking', async () => {
    await setPolicy([])
    const noPolicy = await bookConfirmed(`${suffix}-nopolicy`)
    const net = await walletNet(), before = await sold()
    await expect(cancel(noPolicy.bookingId)).rejects.toThrow('manual review: missing_cancellation_policy')
    expect(await walletNet()).toBe(net); expect(await sold()).toEqual(before)
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: noPolicy.bookingId } })).toMatchObject({ status: 'CONFIRMED' })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.cancel.refused', entityId: noPolicy.bookingId } })).toBe(1)

    await setPolicy([{ daysBeforeCheckin: 3, penaltyPercent: 100 }])
    await expect(cancel(noPolicy.bookingId, { now: new Date('2099-03-02T00:00:00.000Z') })).rejects.toThrow('Stay has already started')
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: noPolicy.bookingId } })).toMatchObject({ status: 'CONFIRMED' })

    const hold = await newHold(`${suffix}-pending`)
    const pending = await tx.prebook({ tenantId, userId, requestId: 'p', inventoryHoldId: hold.holdId, idempotencyKey: `${suffix}-pending`, adults: 2, children: 0, childAges: [], leadGuest: guest })
    await expect(cancel(pending.bookingId)).rejects.toThrow('not cancellable')
    await expect(cancel('does-not-exist')).rejects.toThrow('Booking not found')

    const other = await prisma.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })
    try {
      await expect(cancellations.cancel({ tenantId: other.id, userId, requestId: 'x', bookingId: noPolicy.bookingId })).rejects.toThrow('Booking not found')
      await expect(cancellations.quote({ tenantId: other.id, userId, requestId: 'x', bookingId: noPolicy.bookingId })).rejects.toThrow('Booking not found')
    } finally { await prisma.tenant.delete({ where: { id: other.id } }) }
    await holds.release(tenantId, hold.holdId, 'cleanup', { type: 'USER', userId })
  })
})
