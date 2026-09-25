import { PrismaService } from '../src/database/prisma.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'

describe('inventory hold PostgreSQL concurrency', () => {
  const prisma = new PrismaService()
  const holds = new InventoryHoldService(prisma)
  const suffix = `hold-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string
  let boardId: string, contractId: string, ratePlanId: string

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } }); tenantId = tenant.id
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test` } }); userId = user.id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', legalName: `${suffix} supplier`, displayName: 'Supplier', countryCode: 'AE', defaultCurrency: 'AED' } }); supplierId = supplier.id
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } }); hotelId = hotel.id
    const room = await prisma.roomType.create({ data: { hotelId, name: 'Room', code: suffix, maxAdults: 2, maxOccupancy: 2 } }); roomId = room.id
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'ROH', name: 'Room only hold test' } }); boardId = board.id
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } }); contractId = contract.id
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

  it('allows only one of two parallel requests for the final room', async () => {
    const results = await Promise.allSettled([holds.create(command(`${suffix}-parallel-a`)), holds.create(command(`${suffix}-parallel-b`))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const nights = await prisma.dailyAvailability.findMany({ where: { ratePlanId, stayDate: { lt: new Date('2099-01-03') } }, orderBy: { stayDate: 'asc' }, select: { held: true } })
    expect(nights).toEqual([{ held: 1 }, { held: 1 }])
  })

  it('rolls back every prior night when one night is unavailable', async () => {
    const active = await prisma.inventoryHold.findFirstOrThrow({ where: { tenantId, status: 'HELD' } })
    await holds.release(tenantId, active.id, 'prepare-rollback', { type: 'USER', userId })
    await expect(holds.create(command(`${suffix}-rollback`, '2099-01-04'))).rejects.toThrow('Inventory unavailable')
    const nights = await prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true } })
    expect(nights).toEqual([{ held: 0 }, { held: 0 }, { held: 0 }])
  })
})
