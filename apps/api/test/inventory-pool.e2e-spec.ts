import { PrismaService } from '../src/database/prisma.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { moveNight } from '../src/inventory/inventory-counters'
import { HoldExpirySweeper } from '../src/agent/hold-expiry-sweeper.service'
import { deprovisionHoldExpiryRole, provisionHoldExpiryRole } from '../src/database/hold-expiry-role'
import { randomBytes } from 'node:crypto'

/** Shared allotment pools on real PostgreSQL: one counter for many plans, exactly-once under concurrency, counter fidelity on release. */
describe('shared allotment pool counters (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const holds = new InventoryHoldService(prisma)
  const suffix = `pool-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const D1 = '2099-03-01'; const D2 = '2099-03-02'; const D3 = '2099-03-03'
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, poolId: string
  const planIds: string[] = []; const extra: { hotelMappingId: string; roomMappingId: string } = { hotelMappingId: '', roomMappingId: '' }

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Room', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'ROH', name: `ROH ${suffix}` } })).id
    extra.hotelMappingId = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-sh`, status: 'MAPPED' } })).id
    extra.roomMappingId = (await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: extra.hotelMappingId, hotelId, supplierRoomId: `${suffix}-sr`, roomTypeId: roomId, status: 'MAPPED' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: extra.hotelMappingId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    poolId = (await prisma.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Shared 5', createdById: userId } })).id
    await prisma.inventoryPoolDay.createMany({ data: [D1, D2, D3].map((d) => ({ tenantId, poolId, stayDate: new Date(d), capacity: 5 })) })
    for (const code of ['A', 'B', 'C']) {
      const id = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', inventoryPoolId: poolId } })).id
      planIds.push(id)
      // Each plan row advertises 5 rooms on its own: the pool, not the row, is the stock.
      await prisma.dailyAvailability.createMany({ data: [D1, D2, D3].map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), allotment: 5 })) })
    }
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
    await prisma.ratePlan.deleteMany({ where: { tenantId } })
    await prisma.inventoryPoolDay.deleteMany({ where: { tenantId } })
    await prisma.inventoryPool.deleteMany({ where: { tenantId } })
    await prisma.contract.deleteMany({ where: { tenantId } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
    await prisma.boardBasis.deleteMany({ where: { tenantId } })
    await prisma.roomType.deleteMany({ where: { hotelId } })
    await prisma.hotel.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  const command = (key: string, ratePlanId: string, checkIn = D1, checkOut = D2, rooms = 1) => ({
    tenantId, userId, requestId: `${key}-r`, idempotencyKey: key, offerId: 'o', searchId: 's', ratePlanId, canonicalHotelId: hotelId, canonicalRoomTypeId: roomId,
    boardBasisId: boardId, checkIn, checkOut, rooms, currency: 'AED', sellAmountMinor: 100000, offerExpiresAt: '2099-03-01T12:00:00.000Z',
  })
  const poolDay = (d: string) => prisma.inventoryPoolDay.findFirstOrThrow({ where: { poolId, stayDate: new Date(d) }, select: { id: true, capacity: true, sold: true, held: true } })
  const planHeld = async () => (await prisma.dailyAvailability.aggregate({ where: { tenantId, ratePlanId: { in: planIds } }, _sum: { held: true, sold: true } }))._sum

  it('POOL-01 three plans over five rooms sell exactly five units, not fifteen, under 30 concurrent requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => holds.create(command(`${suffix}-c-${i}`, planIds[i % 3]))))
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(5)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(25)
    const day = await poolDay(D1)
    expect(day).toMatchObject({ capacity: 5, held: 5, sold: 0 })
    expect(await planHeld()).toEqual({ held: 0, sold: 0 }) // the plan rows are never the counter for a pooled plan
    const nights = await prisma.inventoryHoldNight.findMany({ where: { tenantId, stayDate: new Date(D1) } })
    expect(nights).toHaveLength(5)
    expect(nights.every((n) => n.counterKind === 'POOL_DAY' && n.poolDayId === day.id)).toBe(true)
    // release everything: the pool returns to zero held
    for (const r of won) await holds.release(tenantId, (r as PromiseFulfilledResult<{ holdId: string }>).value.holdId, `rel-${suffix}`, { type: 'USER', userId })
    expect((await poolDay(D1)).held).toBe(0)
  })

  it('POOL-02 a multi-night hold is all-or-nothing and takes one counter per night', async () => {
    const full = await prisma.inventoryPoolDay.findFirstOrThrow({ where: { poolId, stayDate: new Date(D2) } })
    await prisma.inventoryPoolDay.update({ where: { id: full.id }, data: { sold: 5 } }) // D2 sold out
    await expect(holds.create(command(`${suffix}-multi`, planIds[0], D1, D3))).rejects.toThrow(/unavailable/i)
    expect((await poolDay(D1)).held).toBe(0) // D1 was rolled back with the failed hold
    expect(await prisma.inventoryHold.count({ where: { tenantId, idempotencyKey: `${suffix}-multi` } })).toBe(0)
    await prisma.inventoryPoolDay.update({ where: { id: full.id }, data: { sold: 0 } })
  })

  it('POOL-03 an identical retry deducts once; release is exactly-once under a double release', async () => {
    const a = await holds.create(command(`${suffix}-idem`, planIds[1], D1, D3))
    const b = await holds.create(command(`${suffix}-idem`, planIds[1], D1, D3))
    expect(b.status).toBe('already_held'); expect(b.holdId).toBe(a.holdId)
    expect([(await poolDay(D1)).held, (await poolDay(D2)).held]).toEqual([1, 1])
    await Promise.all([holds.release(tenantId, a.holdId, 'x1', { type: 'USER', userId }), holds.release(tenantId, a.holdId, 'x2', { type: 'USER', userId })])
    expect([(await poolDay(D1)).held, (await poolDay(D2)).held]).toEqual([0, 0])
  })

  it('POOL-04 release returns to the counter the night was taken from even after the plan leaves the pool', async () => {
    const hold = await holds.create(command(`${suffix}-leave`, planIds[2]))
    expect((await poolDay(D1)).held).toBe(1)
    await prisma.ratePlan.update({ where: { id: planIds[2] }, data: { inventoryPoolId: null } })
    await holds.release(tenantId, hold.holdId, 'leave-rel', { type: 'USER', userId })
    expect((await poolDay(D1)).held).toBe(0)
    expect(await planHeld()).toEqual({ held: 0, sold: 0 })
    await prisma.ratePlan.update({ where: { id: planIds[2] }, data: { inventoryPoolId: poolId } })
  })

  it('POOL-05 confirm moves held to sold on the pool and cancel returns it; a double confirm is refused', async () => {
    const hold = await holds.create(command(`${suffix}-confirm`, planIds[0]))
    const nights = await prisma.inventoryHoldNight.findMany({ where: { holdId: hold.holdId }, select: { availabilityId: true, counterKind: true, poolDayId: true, quantity: true } })
    await prisma.$transaction(async (tx) => { for (const n of nights) await moveNight(tx, tenantId, n, 'confirm') })
    expect(await poolDay(D1)).toMatchObject({ held: 0, sold: 1 })
    await expect(prisma.$transaction(async (tx) => { for (const n of nights) await moveNight(tx, tenantId, n, 'confirm') })).rejects.toThrow(/inconsistent/i)
    await prisma.$transaction(async (tx) => { for (const n of nights) await moveNight(tx, tenantId, n, 'cancel') })
    expect(await poolDay(D1)).toMatchObject({ held: 0, sold: 0 })
    await prisma.inventoryHold.update({ where: { id: hold.holdId }, data: { status: 'RELEASED' } })
  })

  it('POOL-06 modes: FREE_SALE takes no counter; ON_REQUEST, CLOSED, stop sell and stale rows are refused', async () => {
    const plan = planIds[0]
    const set = (data: Record<string, unknown>) => prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: plan, stayDate: new Date(D1) } }, data })
    await set({ inventoryMode: 'FREE_SALE' })
    const free = await holds.create(command(`${suffix}-free`, plan))
    const freeNight = await prisma.inventoryHoldNight.findFirstOrThrow({ where: { holdId: free.holdId } })
    expect(freeNight.counterKind).toBe('NONE'); expect((await poolDay(D1)).held).toBe(0)
    await holds.release(tenantId, free.holdId, 'free-rel', { type: 'USER', userId })
    expect((await poolDay(D1)).held).toBe(0)
    for (const [i, data] of [{ inventoryMode: 'ON_REQUEST' }, { inventoryMode: 'CLOSED' }, { inventoryMode: 'ALLOTMENT', stopSell: true }, { inventoryMode: 'ALLOTMENT', stopSell: false, source: 'SUPPLIER_API', freshUntil: null }, { inventoryMode: 'ALLOTMENT', source: 'ADMIN', receivedAt: new Date(Date.now() - 5000), freshUntil: new Date(Date.now() - 1000) }].entries()) {
      await set(data)
      await expect(holds.create(command(`${suffix}-refuse-${i}`, plan))).rejects.toThrow(/unavailable/i)
    }
    expect((await poolDay(D1)).held).toBe(0)
    await set({ inventoryMode: 'ALLOTMENT', stopSell: false, source: 'ADMIN', freshUntil: null, receivedAt: new Date() })
  })

  it('POOL-07 an archived pool and a stale pool day refuse the reservation', async () => {
    await prisma.inventoryPoolDay.updateMany({ where: { poolId, stayDate: new Date(D1) }, data: { source: 'SUPPLIER_FEED', freshUntil: null } })
    await expect(holds.create(command(`${suffix}-stalepool`, planIds[0]))).rejects.toThrow(/unavailable/i)
    await prisma.inventoryPoolDay.updateMany({ where: { poolId, stayDate: new Date(D1) }, data: { source: 'ADMIN', freshUntil: null } })
    expect((await holds.create(command(`${suffix}-freshpool`, planIds[0]))).status).toBe('held')
    const held = await prisma.inventoryHold.findFirstOrThrow({ where: { tenantId, idempotencyKey: `${suffix}-freshpool` } })
    await holds.release(tenantId, held.id, 'fresh-rel', { type: 'USER', userId })
    await prisma.inventoryPool.update({ where: { id: poolId }, data: { status: 'ARCHIVED', archivedAt: new Date() } })
    await expect(holds.create(command(`${suffix}-archived`, planIds[0]))).rejects.toThrow(/unavailable/i)
    await prisma.inventoryPool.update({ where: { id: poolId }, data: { status: 'ACTIVE', archivedAt: null } })
  })

  it('POOL-08 the database refuses sold + held above capacity even if application code is bypassed', async () => {
    const day = await poolDay(D3)
    await expect(prisma.$executeRaw`UPDATE "InventoryPoolDay" SET "held" = ${day.capacity + 1} WHERE "id" = ${day.id}`).rejects.toThrow()
  })

  it('POOL-09 the restricted hold-expiry role expires a pooled hold and returns the unit to the pool', async () => {
    const roleName = `hx_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
    const password = randomBytes(30).toString('base64url')
    await provisionHoldExpiryRole(prisma, { loginRole: roleName, password })
    try {
      const url = new URL(process.env.DATABASE_URL as string); url.username = roleName; url.password = password
      const due = await holds.create({ ...command(`${suffix}-sweep`, planIds[0]), offerExpiresAt: new Date(Date.now() + 1_500).toISOString() })
      expect((await poolDay(D1)).held).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 1_800))
      const sweeper = new HoldExpirySweeper({ HOLD_EXPIRY_SWEEP_ENABLED: 'true', HOLD_EXPIRY_DATABASE_URL: url.toString(), DATABASE_URL: process.env.DATABASE_URL, HOLD_EXPIRY_SWEEP_INTERVAL_MS: '3600000' })
      await sweeper.onModuleInit()
      try { expect(await sweeper.runOnce()).toBeGreaterThanOrEqual(1) } finally { await sweeper.onModuleDestroy() }
      expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: due.holdId } })).toMatchObject({ status: 'EXPIRED' })
      expect((await poolDay(D1)).held).toBe(0)
    } finally {
      await deprovisionHoldExpiryRole(prisma, roleName)
    }
  })
})
