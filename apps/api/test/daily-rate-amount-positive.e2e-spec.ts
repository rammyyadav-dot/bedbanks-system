import { randomBytes } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'

jest.setTimeout(60_000)

/**
 * ADR 0034: DailyRate_amount_positive. New and updated rows must be greater than zero; the constraint is NOT VALID so legacy rows are never
 * rewritten or scanned. Runs on a disposable database as the owner role (the constraint is a schema rule, not a role rule).
 */
describe('daily rate amount must be greater than zero (PostgreSQL)', () => {
  const prisma = new PrismaClient()
  const suffix = `za-${Date.now()}-${randomBytes(3).toString('hex')}`
  const stay = (offset: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + offset * 86_400_000
  let tenantId = '', planId = ''
  const rate = (offset: number, amountMinor: bigint) => ({ tenantId, ratePlanId: planId, stayDate: new Date(stay(offset)), occupancy: 2, amountMinor, currency: 'AED', amountBasis: 'SELL' as const })

  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: suffix, countryCode: 'AE', defaultCurrency: 'AED' } })
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed and breakfast' } })
    const hotel = await prisma.hotel.create({ data: { tenantId, name: suffix, externalRef: suffix, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: 'D', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId: supplier.id, code: suffix, status: 'ACTIVE', validFrom: new Date(stay(-10)), validTo: new Date(stay(400)), settlementCurrency: 'AED' } })
    planId = (await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: 'ZA-BB', status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })).id
  })

  afterAll(async () => {
    await prisma.dailyRate.deleteMany({ where: { tenantId } })
    await prisma.ratePlan.deleteMany({ where: { tenantId } })
    await prisma.contract.deleteMany({ where: { tenantId } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
    await prisma.hotel.deleteMany({ where: { tenantId } })
    await prisma.boardBasis.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('ZA-01: the constraint exists and is NOT VALID, so existing rows are not scanned or rewritten', async () => {
    const [row] = await prisma.$queryRaw<Array<{ convalidated: boolean; def: string }>>(Prisma.sql`SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'DailyRate_amount_positive' AND conrelid = '"DailyRate"'::regclass`)
    expect(row.def).toBe('CHECK ((amount_minor > 0)) NOT VALID')
    expect(row.convalidated).toBe(false)
  })

  it('ZA-02: a positive rate is accepted; a zero rate is refused on insert and the smallest unit is allowed', async () => {
    await prisma.dailyRate.create({ data: rate(1, 1n) })
    await prisma.dailyRate.create({ data: rate(2, 49_900n) })
    await expect(prisma.dailyRate.create({ data: rate(3, 0n) })).rejects.toThrow(/DailyRate_amount_positive|check constraint/)
    expect(await prisma.dailyRate.count({ where: { ratePlanId: planId } })).toBe(2)
  })

  it('ZA-03: an update to zero is refused and the stored amount is unchanged; a negative amount is still refused by the older check', async () => {
    await expect(prisma.dailyRate.updateMany({ where: { ratePlanId: planId, stayDate: new Date(stay(2)) }, data: { amountMinor: 0n } })).rejects.toThrow(/check constraint/)
    await expect(prisma.dailyRate.create({ data: rate(4, -5n) })).rejects.toThrow(/check constraint/)
    expect((await prisma.dailyRate.findFirstOrThrow({ where: { ratePlanId: planId, stayDate: new Date(stay(2)) } })).amountMinor).toBe(49_900n)
  })

  it('ZA-04: a legacy zero row (written before the constraint) stays readable and can be corrected, but cannot be touched while still zero', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE "DailyRate" DROP CONSTRAINT "DailyRate_amount_positive"')
    try {
      await prisma.dailyRate.create({ data: rate(5, 0n) })
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "DailyRate" ADD CONSTRAINT "DailyRate_amount_positive" CHECK (amount_minor > 0) NOT VALID')
    }
    expect((await prisma.dailyRate.findFirstOrThrow({ where: { ratePlanId: planId, stayDate: new Date(stay(5)) } })).amountMinor).toBe(0n) // not rewritten by the migration
    await expect(prisma.dailyRate.updateMany({ where: { ratePlanId: planId, stayDate: new Date(stay(5)) }, data: { currency: 'AED', amountBasis: 'NET' } })).rejects.toThrow(/check constraint/)
    await expect(prisma.$executeRawUnsafe('ALTER TABLE "DailyRate" VALIDATE CONSTRAINT "DailyRate_amount_positive"')).rejects.toThrow() // fails, changing nothing, while a zero row remains
    await prisma.dailyRate.updateMany({ where: { ratePlanId: planId, stayDate: new Date(stay(5)) }, data: { amountMinor: 30_000n } })
    expect((await prisma.dailyRate.findFirstOrThrow({ where: { ratePlanId: planId, stayDate: new Date(stay(5)) } })).amountMinor).toBe(30_000n)
  })
})
