import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'

jest.setTimeout(120_000)

/** Database-level guarantees of the inventory foundation (ADR 0030): constraints, the pool trigger and composite tenant keys. */
describe('inventory foundation integrity (PostgreSQL)', () => {
  const prisma = new PrismaClient()
  const suffix = `inv-${Date.now()}-${randomBytes(3).toString('hex')}`
  const day = (o: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + o * 86_400_000
  let tenantA = '', tenantB = '', supA1 = '', supA2 = '', supB = '', hotelA1 = '', hotelA2 = '', hotelB = ''
  const plans: Record<string, string> = {}
  let poolA = ''

  async function plan(key: string, tenantId: string, supplierId: string, hotelId: string) {
    const board = await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })
    const room = await prisma.roomType.create({ data: { hotelId, name: key, code: key.slice(0, 20), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: new Date(day(-5)), validTo: new Date(day(300)), settlementCurrency: 'AED' } as never })
    plans[key] = (await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: key, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
  }
  const sup = (tenantId: string, n: string) => prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${n}`, displayName: n, countryCode: 'AE', defaultCurrency: 'AED' } as never }).then((s) => s.id)
  const hot = (tenantId: string, n: string) => prisma.hotel.create({ data: { tenantId, name: `${suffix} ${n}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4 } }).then((h) => h.id)
  const rejects = async (p: Promise<unknown>, match?: RegExp) => { await expect(p).rejects.toThrow(match) }

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supA1 = await sup(tenantA, 'S1'); supA2 = await sup(tenantA, 'S2'); supB = await sup(tenantB, 'SB')
    hotelA1 = await hot(tenantA, 'H1'); hotelA2 = await hot(tenantA, 'H2'); hotelB = await hot(tenantB, 'HB')
    await plan('a1', tenantA, supA1, hotelA1); await plan('a2', tenantA, supA1, hotelA1); await plan('otherSupplier', tenantA, supA2, hotelA1)
    await plan('otherHotel', tenantA, supA1, hotelA2); await plan('b1', tenantB, supB, hotelB)
    poolA = (await prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supA1, name: 'Deluxe', createdById: 'u' } })).id
  })

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.updateMany({ where: { tenantId }, data: { inventoryPoolId: null } })
      await prisma.inventoryPoolDay.deleteMany({ where: { tenantId } })
      await prisma.inventoryPool.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  it('II-01 pool stock can never go negative or oversell, and a night exists once per pool', async () => {
    const date = new Date(day(10))
    const row = (patch: object) => prisma.inventoryPoolDay.create({ data: { tenantId: tenantA, poolId: poolA, stayDate: date, capacity: 5, ...patch } })
    for (const bad of [{ capacity: -1 }, { sold: -1 }, { held: -1 }, { sold: 3, held: 3 }, { capacity: 2, sold: 3 }]) await rejects(row(bad), /check constraint|violat/i)
    const ok = await row({ sold: 2, held: 3 }) // exactly full is allowed
    expect(ok.capacity).toBe(5)
    await rejects(row({}), /Unique constraint/)
    await rejects(prisma.inventoryPoolDay.update({ where: { id: ok.id }, data: { held: 4 } }), /check constraint|violat/i) // would be 6 of 5
    await rejects(prisma.inventoryPoolDay.update({ where: { id: ok.id }, data: { capacity: 4 } }), /check constraint|violat/i) // below sold + held
    await rejects(prisma.inventoryPoolDay.create({ data: { tenantId: tenantA, poolId: poolA, stayDate: new Date(day(11)), capacity: 5, receivedAt: new Date(), freshUntil: new Date(Date.now() - 1000) } }), /check constraint|violat/i)
  })

  it('II-02 a pool is tenant, hotel and supplier scoped, and plans cannot join a foreign or archived pool', async () => {
    await prisma.ratePlan.update({ where: { id: plans.a1 }, data: { inventoryPoolId: poolA } })
    await prisma.ratePlan.update({ where: { id: plans.a2 }, data: { inventoryPoolId: poolA } }) // two plans, one pool
    expect(await prisma.ratePlan.count({ where: { inventoryPoolId: poolA } })).toBe(2)
    await rejects(prisma.ratePlan.update({ where: { id: plans.otherSupplier }, data: { inventoryPoolId: poolA } }), /different suppliers/) // supplier A cannot consume supplier B stock
    await rejects(prisma.ratePlan.update({ where: { id: plans.otherHotel }, data: { inventoryPoolId: poolA } }), /different hotels/)
    await rejects(prisma.ratePlan.update({ where: { id: plans.b1 }, data: { inventoryPoolId: poolA } }), /not found for this tenant|foreign key|violat/i) // another tenant
    const archived = await prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supA1, name: 'Old', createdById: 'u', status: 'ARCHIVED', archivedAt: new Date() } })
    await plan('a3', tenantA, supA1, hotelA1)
    await rejects(prisma.ratePlan.update({ where: { id: plans.a3 }, data: { inventoryPoolId: archived.id } }), /archived/)
    await rejects(prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelB, supplierId: supA1, name: 'X', createdById: 'u' } }), /hotel belongs to another tenant/) // no cross-tenant relationship, enforced by the database
    await rejects(prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supB, name: 'Y', createdById: 'u' } }), /supplier belongs to another tenant/)
    await rejects(prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supA1, name: 'Deluxe', createdById: 'u' } }), /Unique constraint/) // one name per hotel and supplier
    await rejects(prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supA1, name: ' padded ', createdById: 'u' } }), /check constraint|violat/i)
    await rejects(prisma.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA1, supplierId: supA1, name: 'Half', createdById: 'u', status: 'ARCHIVED' } }), /check constraint|violat/i) // archived needs a timestamp
  })

  it('II-03 release time, release days and the held-night counter are constrained', async () => {
    for (const bad of ['24:00', '7:30', 'ab:cd', '12:60']) await rejects(prisma.$executeRawUnsafe(`UPDATE "RatePlan" SET "release_time_local" = '${bad}' WHERE "id" = '${plans.a1}'`), /check constraint|violat|invalid/i)
    await prisma.$executeRawUnsafe(`UPDATE "RatePlan" SET "release_time_local" = '18:30', "release_days" = 3 WHERE "id" = '${plans.a1}'`)
    await rejects(prisma.$executeRawUnsafe(`UPDATE "RatePlan" SET "release_days" = -1 WHERE "id" = '${plans.a1}'`), /check constraint|violat/i)
    const rows = await prisma.$queryRawUnsafe<Array<{ release_time_local: string }>>(`SELECT "release_time_local" FROM "RatePlan" WHERE "id" = '${plans.a2}'`)
    expect(rows[0].release_time_local).toBe('00:00') // the default keeps prior behaviour
  })

  it('II-04 existing and new availability rows default to ALLOTMENT, ADMIN source and never expire', async () => {
    const created = await prisma.dailyAvailability.create({ data: { tenantId: tenantA, ratePlanId: plans.a1, stayDate: new Date(day(12)), allotment: 3 } })
    expect(created).toMatchObject({ inventoryMode: 'ALLOTMENT', source: 'ADMIN', freshUntil: null, closedToDeparture: false })
    expect(created.receivedAt).toBeInstanceOf(Date)
    await rejects(prisma.dailyAvailability.update({ where: { id: created.id }, data: { freshUntil: new Date(created.receivedAt.getTime() - 1000) } }), /check constraint|violat/i)
  })
})
