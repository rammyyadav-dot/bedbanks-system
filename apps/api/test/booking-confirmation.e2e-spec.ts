import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { BookingReconciliationService } from '../src/agent/booking-reconciliation.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'

describe('booking prebook and atomic confirmation (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const reconciliation = new BookingReconciliationService(prisma, finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier), confirmation)
  const suffix = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string, walletId: string

  const commandFor = (key: string, holdId: string) => ({
    tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, inventoryHoldId: holdId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, ratePlanId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03',
    rooms: 1, adults: 2, children: 0, childAges: [], currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Test', lastName: 'Guest' },
  })
  const newHold = (key: string) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z' })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const backdate = (holdId: string, minutes: number) => prisma.$executeRawUnsafe(`UPDATE "InventoryHold" SET "updated_at" = now() - interval '${minutes} minutes' WHERE id = '${holdId}'`)
  const reconcile = (extra: object = {}) => reconciliation.reconcileStale({ tenantId, userId, requestId: `${suffix}-${Math.random()}`, ...extra })

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
    walletId = (await prisma.wallet.create({ data: { tenantId, currency: 'AED', creditLimit: 1_000_000n, cachedBalance: 0n } })).id
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
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
  const prebook = (key: string, holdId: string, extra: object = {}) => tx.prebook({ tenantId, userId, requestId: `${key}-req`, inventoryHoldId: holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest, ...extra })
  const confirm = (bookingId: string) => tx.confirm({ tenantId, userId, requestId: `confirm-${Math.random()}`, bookingId })
  const availability = () => prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true, sold: true } })
  const entries = (bookingId: string) => prisma.ledgerEntry.findMany({ where: { walletId, reference: `booking:${bookingId}` }, orderBy: { immutableAt: 'asc' }, select: { type: true, amountMinor: true } })

  it('prebooks from the server-side hold and confirms atomically: inventory sold, reservation settled to a debit, idempotent', async () => {
    const hold = await newHold(`${suffix}-happy`)
    const pre = await prebook(`${suffix}-happy`, hold.holdId)
    expect(pre).toMatchObject({ status: 'prebooked', supplierReference: 'contracted:test' })
    expect(await availability()).toEqual([{ held: 1, sold: 0 }, { held: 1, sold: 0 }])
    expect(await walletNet()).toBe(-125099n)

    const done = await confirm(pre.bookingId)
    expect(done).toMatchObject({ bookingId: pre.bookingId, status: 'CONFIRMED', alreadyConfirmed: false })
    expect(await availability()).toEqual([{ held: 0, sold: 1 }, { held: 0, sold: 1 }])
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'CONFIRMED' })
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: pre.bookingId } })).toMatchObject({ status: 'CONFIRMED', supplier: 'contracted-inventory' })
    expect(await entries(pre.bookingId)).toEqual([{ type: 'HOLD', amountMinor: -125099n }, { type: 'RELEASE', amountMinor: 125099n }, { type: 'DEBIT', amountMinor: -125099n }])
    expect(await walletNet()).toBe(-125099n) // charged exactly once
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.confirmed', entityId: pre.bookingId, userId } })).toBe(1)

    expect(await confirm(pre.bookingId)).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: true })
    expect((await entries(pre.bookingId)).length).toBe(3)
    expect(await availability()).toEqual([{ held: 0, sold: 1 }, { held: 0, sold: 1 }])
    // a confirmed attempt is invisible to reconciliation, and the sweeper cannot touch the CONFIRMED hold
    await backdate(hold.holdId, 90)
    expect((await reconcile()).examined).toBe(0)
    expect(await holds.expireDue(tenantId, new Date(Date.now() + 3_600_000))).toBe(0)
  })

  it('converges 25 simultaneous confirmations on one sale and one charge', async () => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 5 } })
    const hold = await newHold(`${suffix}-race`)
    const pre = await prebook(`${suffix}-race`, hold.holdId)
    const before = await walletNet()
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => confirm(pre.bookingId)))
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(results.filter((result) => result.status === 'fulfilled' && !result.value.alreadyConfirmed)).toHaveLength(1)
    expect((await entries(pre.bookingId)).map((entry) => entry.type)).toEqual(['HOLD', 'RELEASE', 'DEBIT'])
    expect(await walletNet()).toBe(before)
    const nights = await availability()
    expect(nights.every((night) => night.held === 0)).toBe(true)
    expect(nights.every((night) => night.sold === 2)).toBe(true) // happy path + this booking, no more
  })

  it('refuses to confirm without a prebook, after release, or after reconciliation', async () => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 9 } })
    const bare = await newHold(`${suffix}-bare`)
    const booking = await persistence.persistPending(commandFor(`${suffix}-bare`, bare.holdId))
    await holds.beginProcessing(tenantId, bare.holdId, 'claim', userId)
    await finance.authorize({ tenantId, userId, requestId: 'a', walletId, bookingId: booking.id, currency: 'AED', amountMinor: 125099n, idempotencyKey: `booking:${booking.id}:authorize` })
    await expect(confirm(booking.id)).rejects.toThrow('not been prebooked')

    await backdate(bare.holdId, 60)
    expect((await reconcile()).items.find((item) => item.holdId === bare.holdId)?.outcome).toBe('reconciled')
    await expect(confirm(booking.id)).rejects.toThrow('not confirmable')
    await expect(confirm('does-not-exist')).rejects.toThrow('Booking not found')
  })

  it('rejects insufficient credit, mismatched occupancy and a foreign user without moving money', async () => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 9 } })
    const hold = await newHold(`${suffix}-credit`)
    const net = await walletNet()
    await prisma.wallet.update({ where: { id: walletId }, data: { creditLimit: 0n } })
    await expect(prebook(`${suffix}-credit`, hold.holdId)).rejects.toThrow('Insufficient wallet credit')
    await prisma.wallet.update({ where: { id: walletId }, data: { creditLimit: 1_000_000n } })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' }) // claimed inventory returned
    expect(await walletNet()).toBe(net)

    const second = await newHold(`${suffix}-occ`)
    await expect(prebook(`${suffix}-occ`, second.holdId, { adults: 3 })).rejects.toThrow('occupancy')
    await expect(tx.prebook({ tenantId, userId: 'someone-else', requestId: 'x', inventoryHoldId: second.holdId, idempotencyKey: `${suffix}-other`, adults: 2, children: 0, childAges: [], leadGuest: guest })).rejects.toThrow('unavailable')
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: second.holdId } })).toMatchObject({ status: 'HELD' })
    await holds.release(tenantId, second.holdId, 'cleanup', { type: 'USER', userId })
  })
})
