import { PrismaService } from '../src/database/prisma.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { OfferHoldService } from '../src/agent/offer-hold.service'
import { AgentAuditService } from '../src/agent/audit.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface'

describe('inventory hold PostgreSQL concurrency', () => {
  const prisma = new PrismaService()
  const holds = new InventoryHoldService(prisma)
  const suffix = `hold-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string
  let boardId: string, contractId: string, ratePlanId: string, hotelMappingId: string, roomMappingId: string

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } }); tenantId = tenant.id
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test` } }); userId = user.id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} supplier`, displayName: 'Supplier', countryCode: 'AE', defaultCurrency: 'AED' } }); supplierId = supplier.id
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } }); hotelId = hotel.id
    const room = await prisma.roomType.create({ data: { hotelId, name: 'Room', code: suffix, maxAdults: 2, maxOccupancy: 2 } }); roomId = room.id
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'ROH', name: 'Room only hold test' } }); boardId = board.id
    const hotelMapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-supplier-hotel`, status: 'MAPPED' } }); hotelMappingId = hotelMapping.id
    const roomMapping = await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: hotelMappingId, hotelId, supplierRoomId: `${suffix}-supplier-room`, roomTypeId: roomId, status: 'MAPPED' } }); roomMappingId = roomMapping.id
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: hotelMappingId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } }); contractId = contract.id
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } }); ratePlanId = plan.id
    await prisma.dailyAvailability.createMany({ data: [
      { tenantId, ratePlanId, stayDate: new Date('2099-01-01'), allotment: 1 },
      { tenantId, ratePlanId, stayDate: new Date('2099-01-02'), allotment: 1 },
      { tenantId, ratePlanId, stayDate: new Date('2099-01-03'), allotment: 0 },
    ] })
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId } })
    await prisma.ratePlan.delete({ where: { id: ratePlanId } })
    await prisma.contract.delete({ where: { id: contractId } })
    await prisma.supplierRoomMapping.delete({ where: { id: roomMappingId } })
    await prisma.supplierHotelMapping.delete({ where: { id: hotelMappingId } })
    await prisma.boardBasis.delete({ where: { id: boardId } })
    await prisma.roomType.delete({ where: { id: roomId } })
    await prisma.hotel.delete({ where: { id: hotelId } })
    await prisma.supplier.delete({ where: { id: supplierId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  const command = (key: string, checkOut = '2099-01-03') => ({
    tenantId, userId, requestId: `${key}-request`, idempotencyKey: key,
    offerId: 'offer-a', searchId: 'search-a', ratePlanId, canonicalHotelId: hotelId,
    canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-01-01', checkOut,
    rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-01-01T12:00:00.000Z',
  })

  it('deducts once for an identical retry and releases once', async () => {
    const first = await holds.create(command(`${suffix}-same`))
    const retry = await holds.create(command(`${suffix}-same`))
    expect(first.status).toBe('held'); expect(retry.status).toBe('already_held'); expect(retry.holdId).toBe(first.holdId)
    expect(await prisma.dailyAvailability.findMany({ where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } }, orderBy: { stayDate: 'asc' }, select: { held: true } })).toEqual([{ held: 1 }, { held: 1 }])
    await Promise.all([holds.release(tenantId, first.holdId, 'release-a', { type: 'USER', userId }), holds.release(tenantId, first.holdId, 'release-b', { type: 'USER', userId })])
    expect(await prisma.dailyAvailability.findMany({ where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } }, orderBy: { stayDate: 'asc' }, select: { held: true } })).toEqual([{ held: 0 }, { held: 0 }])
  })

  it('allows exactly one of 25 simultaneous requests for the final room', async () => {
    const attempts = 25
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const startTogether = async () => {
      arrived += 1
      if (arrived === attempts) release()
      await gate
    }

    const results = await Promise.allSettled(Array.from({ length: attempts }, async (_, index) => {
      await startTogether()
      return holds.create(command(`${suffix}-parallel-${index}`))
    }))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(24)

    const nights = await prisma.dailyAvailability.findMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      orderBy: { stayDate: 'asc' },
      select: { id: true, allotment: true, sold: true, held: true },
    })
    expect(nights).toHaveLength(2)
    for (const night of nights) {
      expect(night.held).toBe(1)
      expect(night.sold + night.held).toBeLessThanOrEqual(night.allotment)
    }

    const successful = results.find(result => result.status === 'fulfilled')
    if (!successful || successful.status !== 'fulfilled') throw new Error('Expected one successful hold')
    const durableHold = await prisma.inventoryHold.findUniqueOrThrow({ where: { id: successful.value.holdId } })
    expect(durableHold).toMatchObject({ tenantId, status: 'HELD', rooms: 1 })
    const durableNights = await prisma.inventoryHoldNight.findMany({ where: { holdId: durableHold.id }, orderBy: { stayDate: 'asc' } })
    expect(durableNights).toHaveLength(2)
    expect(durableNights.every(night => night.quantity === 1)).toBe(true)
  })

  it('allows exactly five of 25 simultaneous requests when five rooms remain', async () => {
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      data: { allotment: 5, held: 0, sold: 0 },
    })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })

    const attempts = 25
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const results = await Promise.allSettled(Array.from({ length: attempts }, async (_, index) => {
      arrived += 1
      if (arrived === attempts) release()
      await gate
      return holds.create(command(`${suffix}-capacity-${index}`))
    }))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(20)
    const nights = await prisma.dailyAvailability.findMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      orderBy: { stayDate: 'asc' },
      select: { allotment: true, sold: true, held: true },
    })
    for (const night of nights) {
      expect(night.held).toBe(5)
      expect(night.sold + night.held).toBeLessThanOrEqual(night.allotment)
    }
    expect(await prisma.inventoryHold.count({ where: { tenantId, status: 'HELD' } })).toBe(5)
    expect(await prisma.inventoryHoldNight.count({ where: { tenantId } })).toBe(10)
  })

  it('converges 25 identical idempotent requests on one durable hold', async () => {
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      data: { allotment: 1, held: 0, sold: 0 },
    })
    const same = command(`${suffix}-idempotent-race`)
    const results = await Promise.all(Array.from({ length: 25 }, () => holds.create(same)))
    expect(new Set(results.map(result => result.holdId)).size).toBe(1)
    expect(results.filter(result => result.status === 'held')).toHaveLength(1)
    expect(results.filter(result => result.status === 'already_held')).toHaveLength(24)
    expect(await prisma.inventoryHold.count({ where: { tenantId, idempotencyKey: same.idempotencyKey } })).toBe(1)
    expect(await prisma.inventoryHoldNight.count({ where: { tenantId } })).toBe(2)
    const nights = await prisma.dailyAvailability.findMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      orderBy: { stayDate: 'asc' },
      select: { allotment: true, sold: true, held: true },
    })
    for (const night of nights) expect(night).toMatchObject({ allotment: 1, sold: 0, held: 1 })
  })

  it('restores inventory exactly once under 25 simultaneous releases', async () => {
    const active = await prisma.inventoryHold.findFirstOrThrow({ where: { tenantId, status: 'HELD' } })
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      holds.release(tenantId, active.id, `release-race-${index}`, { type: 'USER', userId }),
    ))
    const nights = await prisma.dailyAvailability.findMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      orderBy: { stayDate: 'asc' },
      select: { held: true },
    })
    expect(nights).toEqual([{ held: 0 }, { held: 0 }])
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ status: 'RELEASED' })
  })

  it('preserves inventory bounds when hold allocation races release restoration', async () => {
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      data: { allotment: 1, sold: 0, held: 0 },
    })

    const existing = await holds.create(command(`${suffix}-hold-release-existing`))
    expect(existing.status).toBe('held')

    let arrived = 0
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const startTogether = async () => {
      arrived += 1
      if (arrived === 2) releaseGate()
      await gate
    }

    const [releaseResult, allocationResult] = await Promise.allSettled([
      (async () => {
        await startTogether()
        return holds.release(tenantId, existing.holdId, `${suffix}-hold-release-release`, { type: 'USER', userId })
      })(),
      (async () => {
        await startTogether()
        return holds.create(command(`${suffix}-hold-release-new`))
      })(),
    ])

    expect(releaseResult.status).toBe('fulfilled')
    expect(['fulfilled', 'rejected']).toContain(allocationResult.status)

    const nights = await prisma.dailyAvailability.findMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      orderBy: { stayDate: 'asc' },
      select: { allotment: true, sold: true, held: true },
    })
    expect(nights).toHaveLength(2)
    for (const night of nights) {
      expect(night.held).toBeGreaterThanOrEqual(0)
      expect(night.sold + night.held).toBeGreaterThanOrEqual(0)
      expect(night.sold + night.held).toBeLessThanOrEqual(night.allotment)
    }

    const expectedHeld = allocationResult.status === 'fulfilled' ? 1 : 0
    expect(nights).toEqual([
      { allotment: 1, sold: 0, held: expectedHeld },
      { allotment: 1, sold: 0, held: expectedHeld },
    ])

    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: existing.holdId } })).toMatchObject({ status: 'RELEASED' })
    if (allocationResult.status === 'fulfilled') {
      expect(allocationResult.value.status).toBe('held')
      expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: allocationResult.value.holdId } })).toMatchObject({ status: 'HELD' })
    } else {
      expect(allocationResult.reason).toBeInstanceOf(ConflictException)
    }
  })

  it('rolls back every prior night when one night is unavailable', async () => {
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId },
      data: { held: 0, sold: 0 },
    })
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } },
      data: { allotment: 1 },
    })
    await prisma.dailyAvailability.updateMany({
      where: { ratePlanId, stayDate: new Date('2099-01-03') },
      data: { allotment: 0 },
    })
    await expect(holds.create(command(`${suffix}-rollback`, '2099-01-04'))).rejects.toThrow('Inventory unavailable')
    const nights = await prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true } })
    expect(nights).toEqual([{ held: 0 }, { held: 0 }, { held: 0 }])
  })

  it('creates an atomic hold only after an authoritative recheck and verified mappings', async () => {
    const offer = { offerId: 'verified-offer', searchId: 'verified-search', supplierId, supplierHotelId: `${suffix}-supplier-hotel`,
      supplierRoomId: `${suffix}-supplier-room`, canonicalHotelId: hotelId, canonicalRoomTypeId: roomId,
      ratePlanId, boardBasisId: boardId, checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1,
      adults: 2, children: 0, childAges: [], currency: 'AED', sellAmountMinor: 125099, expiresAt: '2099-01-01T12:00:00.000Z' }
    const supplier = { name: 'postgres-test-adapter', search: jest.fn(), recheck: jest.fn().mockResolvedValue({ status: 'available', offer }),
      prebook: jest.fn(), cancel: jest.fn() } as unknown as SupplierAdapter
    const service = new OfferHoldService(supplier, prisma, holds, new AgentAuditService(prisma))
    const result = await service.execute({ offerId: offer.offerId, searchId: offer.searchId, expectedCurrency: 'AED',
      expectedSellAmountMinor: 125099, idempotencyKey: `${suffix}-verified`, tenantId, requestId: `${suffix}-verified-request`,
      user: { user: { id: userId } } as AuthenticatedUser })
    expect(result).toMatchObject({ status: 'held', offerId: offer.offerId, searchId: offer.searchId })
    expect(await prisma.inventoryHold.findUnique({ where: { id: result.holdId! } })).toMatchObject({ tenantId, status: 'HELD' })
    await holds.release(tenantId, result.holdId!, `${suffix}-verified-release`, { type: 'USER', userId })
  })
})
