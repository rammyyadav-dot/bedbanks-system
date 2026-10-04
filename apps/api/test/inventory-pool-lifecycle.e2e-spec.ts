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
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { InventoryAdminService } from '../src/inventory/inventory-admin.service'
import { HotelQuickUpdateService } from '../src/hotel-setup/hotel-quick-update.service'
import { moveNight } from '../src/inventory/inventory-counters'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'

/**
 * Whole shared-pool lifecycle on PostgreSQL through the real services (no HTTP, no supplier, no payment provider):
 * hold, prebook, confirm, cancel, expiry, search, recheck and Admin changes, with the pool counters checked after every step.
 */
describe('shared pool counter lifecycle (PostgreSQL)', () => {
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
  const adapter = new ContractedInventoryAdapter(prisma)
  const admin = new InventoryAdminService(prisma)
  const quick = new HotelQuickUpdateService(prisma)
  const suffix = `lc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const IN = '2099-04-01', OUT = '2099-04-03'
  const N1 = new Date(IN), N2 = new Date('2099-04-02')
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, poolId: string, walletId: string
  const plans: string[] = []

  const poolDays = () => prisma.inventoryPoolDay.findMany({ where: { poolId, stayDate: { in: [N1, N2] } }, orderBy: { stayDate: 'asc' }, select: { capacity: true, sold: true, held: true } })
  const planCounters = async () => (await prisma.dailyAvailability.aggregate({ where: { tenantId, ratePlanId: { in: plans } }, _sum: { sold: true, held: true } }))._sum
  const newHold = (key: string, planIdx = 0, checkOut = OUT, rooms = 1) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `o-${key}`, searchId: `s-${key}`, ratePlanId: plans[planIdx],
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: IN, checkOut, rooms, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-04-01T12:00:00.000Z' })
  const guest = { firstName: 'Test', lastName: 'Guest' }
  const book = async (key: string, planIdx = 0) => {
    const hold = await newHold(key, planIdx)
    const pre = await tx.prebook({ tenantId, userId, requestId: `${key}-req`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
    return { hold, pre }
  }
  const confirm = (bookingId: string) => tx.confirm({ tenantId, userId, requestId: `c-${Math.random()}`, bookingId })
  const cancel = (bookingId: string) => cancellations.cancel({ tenantId, userId, requestId: `x-${Math.random()}`, bookingId, reason: 'guest request' })
  const invariant = async () => {
    const days = await prisma.inventoryPoolDay.findMany({ where: { tenantId } })
    for (const d of days) { expect(d.sold).toBeGreaterThanOrEqual(0); expect(d.held).toBeGreaterThanOrEqual(0); expect(d.sold + d.held).toBeLessThanOrEqual(d.capacity) }
    const rows = await prisma.dailyAvailability.findMany({ where: { tenantId } })
    for (const r of rows) { expect(r.sold).toBeGreaterThanOrEqual(0); expect(r.held).toBeGreaterThanOrEqual(0) }
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 5 } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    const mapping = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })).id
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping, hotelId, supplierRoomId: `${suffix}-r`, roomTypeId: roomId, status: 'MAPPED' } })
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 3, penaltyPercent: 100 } })
    poolId = (await prisma.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Shared 5', createdById: userId } })).id
    await prisma.inventoryPoolDay.createMany({ data: [N1, N2].map((stayDate) => ({ tenantId, poolId, stayDate, capacity: 5 })) })
    for (const code of ['A', 'B', 'C']) {
      const id = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', inventoryPoolId: poolId } })).id
      plans.push(id)
      await prisma.dailyAvailability.createMany({ data: [N1, N2].map((stayDate) => ({ tenantId, ratePlanId: id, stayDate, allotment: 5 })) })
    }
    walletId = (await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n)).walletId // ADR 0028 slice 3: the booker's agency account
  })

  afterAll(async () => {
    for (const f of [() => prisma.auditEvent.deleteMany({ where: { tenantId } }), () => prisma.ledgerEntry.deleteMany({ where: { tenantId } }), () => prisma.supplierMutation.deleteMany({ where: { tenantId } }),
      () => prisma.cancellation.deleteMany({ where: { booking: { tenantId } } }), () => prisma.booking.deleteMany({ where: { tenantId } }), () => prisma.inventoryHoldNight.deleteMany({ where: { tenantId } }), () => prisma.inventoryHold.deleteMany({ where: { tenantId } }),
      () => prisma.wallet.deleteMany({ where: { tenantId } }), () => removeAgencyBookers(prisma, tenantId), () => prisma.dailyAvailability.deleteMany({ where: { tenantId } }), () => prisma.dailyRate.deleteMany({ where: { tenantId } }), () => prisma.ratePlan.deleteMany({ where: { tenantId } }),
      () => prisma.inventoryPoolDay.deleteMany({ where: { tenantId } }), () => prisma.inventoryPool.deleteMany({ where: { tenantId } }), () => prisma.cancellationPolicy.deleteMany({ where: { contractId } }), () => prisma.contract.deleteMany({ where: { tenantId } }),
      () => prisma.supplierRoomMapping.deleteMany({ where: { tenantId } }), () => prisma.supplierHotelMapping.deleteMany({ where: { tenantId } }), () => prisma.boardBasis.deleteMany({ where: { tenantId } }), () => prisma.roomType.deleteMany({ where: { hotelId } }),
      () => prisma.hotel.deleteMany({ where: { tenantId } }), () => prisma.supplier.deleteMany({ where: { tenantId } }), () => prisma.membership.deleteMany({ where: { tenantId } }), () => prisma.user.deleteMany({ where: { id: userId } }), () => prisma.tenant.deleteMany({ where: { id: tenantId } })]) await f()
    await prisma.$disconnect()
  })

  it('LC-01 three plans over five rooms: holds on different plans draw one counter; a sixth room is refused whichever plan asks', async () => {
    const h = [await newHold(`${suffix}-a`, 0), await newHold(`${suffix}-b`, 1), await newHold(`${suffix}-c`, 2), await newHold(`${suffix}-d`, 0), await newHold(`${suffix}-e`, 1)]
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 5 }, { capacity: 5, sold: 0, held: 5 }])
    expect(await planCounters()).toEqual({ sold: 0, held: 0 })
    for (const idx of [0, 1, 2]) await expect(newHold(`${suffix}-over-${idx}`, idx)).rejects.toThrow(/unavailable/i)
    expect(await prisma.inventoryHold.count({ where: { tenantId, idempotencyKey: { startsWith: `${suffix}-over` } } })).toBe(0)
    const nights = await prisma.inventoryHoldNight.findMany({ where: { holdId: { in: h.map((x) => x.holdId) } } })
    expect(nights).toHaveLength(10); expect(nights.every((n) => n.counterKind === 'POOL_DAY' && n.poolDayId !== null)).toBe(true)
    for (const x of h) await holds.release(tenantId, x.holdId, 'lc-1', { type: 'USER', userId })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }]); await invariant()
  })

  it('LC-02 a failed multi-night hold rolls back every counter, the hold row and the audit event', async () => {
    await prisma.inventoryPoolDay.updateMany({ where: { poolId, stayDate: N2 }, data: { sold: 5 } }) // second night full
    const auditBefore = await prisma.auditEvent.count({ where: { tenantId, action: 'inventory.hold.created' } })
    await expect(newHold(`${suffix}-fail`)).rejects.toThrow(/unavailable/i)
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 5, held: 0 }])
    expect(await prisma.inventoryHold.count({ where: { tenantId, idempotencyKey: `${suffix}-fail` } })).toBe(0)
    expect(await prisma.inventoryHoldNight.count({ where: { tenantId, hold: { idempotencyKey: `${suffix}-fail` } } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'inventory.hold.created' } })).toBe(auditBefore)
    expect(await planCounters()).toEqual({ sold: 0, held: 0 })
    await prisma.inventoryPoolDay.updateMany({ where: { poolId }, data: { sold: 0 } })
  })

  it('LC-03 prebook then confirm moves held to sold on the pool only, once; a repeat confirm changes nothing', async () => {
    const { hold, pre } = await book(`${suffix}-bk1`, 1)
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 1 }, { capacity: 5, sold: 0, held: 1 }])
    expect(await confirm(pre.bookingId)).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 1, held: 0 }, { capacity: 5, sold: 1, held: 0 }])
    expect(await confirm(pre.bookingId)).toMatchObject({ alreadyConfirmed: true })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 1, held: 0 }, { capacity: 5, sold: 1, held: 0 }])
    expect(await planCounters()).toEqual({ sold: 0, held: 0 })
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).status).toBe('CONFIRMED')
    ids.confirmed = pre.bookingId
  })

  const ids: { confirmed?: string } = {}

  it('LC-04 changing pool membership after the sale cannot redirect it: cancel returns to the pool day, once, never negative', async () => {
    await prisma.ratePlan.update({ where: { id: plans[1] }, data: { inventoryPoolId: null } }) // the selling plan leaves the pool
    const result = await cancel(ids.confirmed!)
    expect(result).toMatchObject({ status: 'CANCELLED', alreadyCancelled: false })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }])
    expect(await planCounters()).toEqual({ sold: 0, held: 0 })
    expect(await cancel(ids.confirmed!)).toMatchObject({ alreadyCancelled: true })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }])
    await prisma.ratePlan.update({ where: { id: plans[1] }, data: { inventoryPoolId: poolId } }); await invariant()
  })

  it('LC-05 expiry returns the unit to its original pool day exactly once; a repeated sweep and a repeated release change nothing', async () => {
    const h = await holds.create({ tenantId, userId, requestId: 'exp', idempotencyKey: `${suffix}-exp`, offerId: 'o', searchId: 's', ratePlanId: plans[2], canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: IN, checkOut: OUT, rooms: 2, currency: 'AED', sellAmountMinor: 1, offerExpiresAt: new Date(Date.now() + 1000).toISOString() })
    expect((await poolDays())[0].held).toBe(2)
    await prisma.ratePlan.update({ where: { id: plans[2] }, data: { inventoryPoolId: null } }) // membership changes while the hold is live
    const later = new Date(Date.now() + 3_600_000)
    expect(await holds.expireDue(tenantId, later)).toBe(1)
    expect(await holds.expireDue(tenantId, later)).toBe(0)
    await holds.release(tenantId, h.holdId, 'again', { type: 'USER', userId })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }])
    const night = await prisma.inventoryHoldNight.findFirstOrThrow({ where: { holdId: h.holdId } })
    await expect(prisma.$transaction((t) => moveNight(t, tenantId, night, 'release'))).rejects.toThrow(/inconsistent/i) // a forced second release is refused, not applied
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }])
    await prisma.ratePlan.update({ where: { id: plans[2] }, data: { inventoryPoolId: poolId } }); await invariant()
  })

  it('LC-06 search and recheck never consume: pool and plan counters are identical before and after', async () => {
    await prisma.dailyRate.createMany({ data: plans.flatMap((ratePlanId) => [day(30), day(31)].map((d) => ({ tenantId, ratePlanId, stayDate: new Date(d), occupancy: 2, amountMinor: 50_000n, amountBasis: 'SELL' as const, currency: 'AED' }))) })
    await prisma.dailyAvailability.createMany({ data: plans.flatMap((ratePlanId) => [day(30), day(31)].map((d) => ({ tenantId, ratePlanId, stayDate: new Date(d), allotment: 9 }))) })
    await prisma.inventoryPoolDay.createMany({ data: [day(30), day(31)].map((d) => ({ tenantId, poolId, stayDate: new Date(d), capacity: 3 })) })
    const snapshot = async () => JSON.stringify([await prisma.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' }, select: { capacity: true, sold: true, held: true } }), await prisma.dailyAvailability.findMany({ where: { tenantId }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }], select: { sold: true, held: true, allotment: true } })])
    const before = await snapshot()
    const criteria = { destination: 'Dubai', checkIn: day(30), checkOut: day(32), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED' }
    for (let i = 0; i < 5; i++) {
      const found = (await adapter.search(criteria, { tenantId, requestId: `s${i}` })).offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
      expect(found).toHaveLength(3)
      for (const rate of found) expect(await adapter.recheck({ offerId: rate.offerId, searchId: 's' }, { tenantId, userId, requestId: 'r' })).toMatchObject({ status: 'available' })
    }
    expect(await snapshot()).toBe(before)
  })

  it('LC-07 Admin cannot cut capacity below active consumption, cannot archive a pool that still carries units, and removing members leaves the live hold on its pool day', async () => {
    const h = await newHold(`${suffix}-live`, 0, OUT, 3)
    const role = await prisma.role.create({ data: { tenantId, name: `r-${suffix}` } })
    for (const key of ['supply.availability.manage', 'supply.rates.read']) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { tenantId, userId, roleId: role.id } })
    const scope = { ratePlanIds: [plans[0]], ranges: [{ from: IN, to: IN }] }
    const low = await quick.preview(tenantId, userId, hotelId, { scope, changes: { availability: { allotment: 2 } } })
    expect(low.canApply).toBe(false); expect(low.rows[0].problems.join(' ')).toMatch(/below the 3 already sold or held on the pool/)
    expect((await quick.preview(tenantId, userId, hotelId, { scope, changes: { availability: { allotment: 3 } } })).canApply).toBe(true)
    const token = (await admin.summary(tenantId, hotelId, { from: IN, days: 2 })).pools[0].updatedAt
    const removed = await admin.removeMembers(tenantId, userId, hotelId, poolId, { ratePlanIds: plans, expectedUpdatedAt: token, idempotencyKey: `${suffix}-rm-all` }, null)
    expect(removed.pool!.members).toHaveLength(0)
    await expect(admin.updatePool(tenantId, userId, hotelId, poolId, { archive: true, expectedUpdatedAt: removed.pool!.updatedAt, idempotencyKey: `${suffix}-arch` }, null)).rejects.toMatchObject({ response: { code: 'POOL_HAS_COMMITMENTS' } })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 3 }, { capacity: 5, sold: 0, held: 3 }]) // the live hold still sits on the pool days
    await holds.release(tenantId, h.holdId, 'lc-7', { type: 'USER', userId })
    expect(await poolDays()).toEqual([{ capacity: 5, sold: 0, held: 0 }, { capacity: 5, sold: 0, held: 0 }])
    await invariant()
    void walletId
  })
})
