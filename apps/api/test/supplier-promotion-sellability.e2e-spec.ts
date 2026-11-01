import { randomBytes } from 'crypto'
import type { IngestAllotment, IngestRate, IngestResult } from '@bedbanks/connectors-core'
import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { PrismaService } from '../src/database/prisma.service'
import { deprovisionPromoteRole, provisionPromoteRole } from '../src/database/supplier-promotion-role'
import { IngestProfileRegistry } from '../src/supplier-ingest/ingest-profile'
import { persistAllotments, persistRates, type PersistScope } from '../src/supplier-ingest/ingest-persistence'
import { SupplierPromotionDatabase } from '../src/supplier-promotion/supplier-promotion.database'
import { SupplierPromotionService } from '../src/supplier-promotion/supplier-promotion.service'

jest.setTimeout(180_000)

/**
 * ADR 0084 gap closure: rows written by the promotion role are what Agent search and recheck actually sell, through the one canonical evaluator and its real gates
 * (NET needs a markup rule, stock is shared across a pool, freshness fails closed, a closed night hides the offer). PostgreSQL, no mocks.
 */
describe('promoted supplier inventory is what search and recheck sell', () => {
  const owner = new PrismaService()
  const adapter = new ContractedInventoryAdapter(owner)
  const suffix = `sell-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const loginRole = `fbeds_promote_s${randomBytes(4).toString('hex')}`
  const profiles = new IngestProfileRegistry()
  let database: SupplierPromotionDatabase
  let service: SupplierPromotionService
  let tenantId = '', supplierId = '', connectorId = '', hotelId = '', userId = '', poolId = '', hotelMappingId = ''
  let planA = '', planP1 = '', planP2 = '', planNoTax = ''
  const roomIds: Record<string, string> = {}
  const dayStr = (n: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + n * 86_400_000
  const iso = (n: number) => new Date(dayStr(n)).toISOString().slice(0, 10)
  const checkIn = iso(20), checkOut = iso(22)
  const criteria = (): SearchCriteria => ({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED' })
  const ctx = () => ({ tenantId, requestId: 'r' })
  const search = async (): Promise<SearchRateOffer[]> => (await adapter.search(criteria(), ctx())).offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
  const forPlan = (list: SearchRateOffer[], id: string) => list.find((r) => r.ratePlanId === id)
  let clock = 0
  const nextNow = () => new Date(Date.now() + 1000 * ++clock)
  let seq = 0

  profiles.register({ key: 'sell-feed', format: 'json', amountBasis: 'NET', allotmentSemantics: 'REMAINING', coverageDays: 60, freshnessMs: 3_600_000, specs: { RATES: { recordPath: 'a[]', fields: {} }, ALLOTMENTS: { recordPath: 'a[]', fields: {} } } })

  const rate = (room: string, plan: string, night: number, net: number): IngestRate => ({ supplierHotelCode: 'H1', supplierRoomCode: room, supplierRatePlanCode: plan, boardCode: null, stayDate: iso(night), currency: 'AED', netMinor: net, taxesIncluded: true, minStay: null, maxStay: null, closedToArrival: false, closedToDeparture: false })
  const stock = (room: string, plan: string | null, night: number, available: number): IngestAllotment => ({ supplierHotelCode: 'H1', supplierRoomCode: room, supplierRatePlanCode: plan, stayDate: iso(night), mode: 'ALLOTMENT', available, stopSell: false, releaseDays: null })
  const done = <T,>(accepted: T[]): IngestResult<T> => ({ accepted, rejected: [], extracted: accepted.length, status: 'COMPLETE' })
  const scope = (key: string, at: Date): PersistScope => ({ tenantId, supplierId, connectorId, idempotencyKey: key, actorUserId: null, receivedAt: at, sourceUpdatedAt: null, freshUntil: new Date(at.getTime() + 3_600_000) })
  const ingestRates = (rows: IngestRate[]) => owner.withTenant(tenantId, (tx) => persistRates(tx, scope(`r-${++seq}-${suffix}`.slice(0, 60), nextNow()), done(rows)))
  const ingestStock = (rows: IngestAllotment[]) => owner.withTenant(tenantId, (tx) => persistAllotments(tx, scope(`s-${++seq}-${suffix}`.slice(0, 60), nextNow()), done(rows)))
  const promote = () => service.promote({ tenantId, supplierId, connectorId, profileKey: 'sell-feed', idempotencyKey: `promotion-${++seq}-${suffix}`, now: new Date(Date.now() + 60_000) })

  async function plan(room: string, code: string, extra: Record<string, unknown> = {}) {
    const board = await owner.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'ROH' } }, update: {}, create: { tenantId, code: 'ROH', name: `ROH ${suffix}` } })
    const contract = await owner.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: hotelMappingId, code: `${suffix}-${code}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
    return (await owner.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: roomIds[room], boardBasisId: board.id, code: `${suffix}-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', taxesIncluded: true, ...extra } })).id
  }

  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionPromoteRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString()); login.username = loginRole; login.password = password
    database = new SupplierPromotionDatabase({ SUPPLIER_PROMOTION_DATABASE_URL: login.toString(), DATABASE_URL: ownerUrl.toString() })
    service = new SupplierPromotionService(database, profiles)

    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await owner.user.create({ data: { email: `${suffix}@example.test` } })).id
    await owner.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    connectorId = (await owner.connectorDefinition.create({ data: { tenantId, supplierId, type: 'CHANNEL_MANAGER', status: 'ACTIVE', name: 'cm', version: '0.0.1' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId, name: `${suffix} hotel`, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE' } })).id
    for (const code of ['DLX', 'STD', 'TAX']) roomIds[code] = (await owner.roomType.create({ data: { hotelId, name: code, code: `${suffix}-${code}`.slice(0, 40), maxAdults: 2, maxOccupancy: 2 } })).id
    hotelMappingId = (await owner.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: 'H1', status: 'MAPPED' } })).id
    const room = async (code: string, room: string) => (await owner.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: hotelMappingId, hotelId, supplierRoomId: code, roomTypeId: roomIds[room], status: 'MAPPED' } })).id
    const dbl = await room('DBL', 'DLX'); const twn = await room('TWN', 'STD'); const tax = await room('TAX', 'TAX')
    poolId = (await owner.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Standard', createdById: userId } })).id
    planA = await plan('DLX', 'A'); planP1 = await plan('STD', 'P1', { inventoryPoolId: poolId }); planP2 = await plan('STD', 'P2', { inventoryPoolId: poolId }); planNoTax = await plan('TAX', 'N', { taxesIncluded: false })
    const map = (r: string, code: string, id: string) => owner.supplierRatePlanMapping.create({ data: { tenantId, supplierRoomMappingId: r, supplierRatePlanCode: code, ratePlanId: id, status: 'MAPPED' } })
    await map(dbl, 'BAR', planA); await map(twn, 'P1', planP1); await map(twn, 'P2', planP2); await map(tax, 'N', planNoTax)
  })

  afterAll(async () => {
    await database.onModuleDestroy()
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('fbeds.ingest_erasure', 'on', true)`
      for (const table of ['SupplierPromotionRun', 'SupplierRateObservation', 'SupplierAllotmentObservation', 'SupplierCancellationObservation', 'SupplierIngestRun', 'AuditEvent', 'CommercialMarkupRule', 'DailyRate', 'DailyAvailability', 'InventoryPoolDay', 'SupplierRatePlanMapping', 'SupplierRoomMapping']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('UPDATE "RatePlan" SET inventory_pool_id = NULL WHERE tenant_id = $1', tenantId)
      for (const table of ['RatePlan', 'Contract', 'SupplierHotelMapping', 'InventoryPool', 'BoardBasis', 'ConnectorDefinition']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('DELETE FROM "RoomType" WHERE hotel_id = $1', hotelId)
      for (const table of ['Hotel', 'Supplier', 'memberships']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('DELETE FROM users WHERE id = $1', userId)
      await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
    })
    await deprovisionPromoteRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('SELL-01 nothing is sold before promotion, and a promoted NET rate still needs an active markup rule', async () => {
    expect(forPlan(await search(), planA)).toBeUndefined()
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await ingestStock([stock('DBL', 'BAR', 20, 4), stock('DBL', 'BAR', 21, 4)])
    expect(await promote()).toMatchObject({ status: 'APPLIED', ratesPromoted: 2, nightsPromoted: 2 })
    // Rates and stock are in place, but NET without a markup rule is deliberately unsellable (ADR 0018).
    expect(forPlan(await search(), planA)).toBeUndefined()
  })

  it('SELL-02 with an active markup rule the promoted plan is sold at net plus integer markup, available, and recheck confirms it', async () => {
    await owner.commercialMarkupRule.create({ data: { tenantId, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date('2026-01-01'), status: 'ACTIVE', activatedAt: new Date(), reason: 'test', createdById: userId } })
    const offer = forPlan(await search(), planA)
    expect(offer).toMatchObject({ availability: 'available', available: true, netAmountMinor: 82_500, markupAmountMinor: 8_250, sellAmountMinor: 90_750 })
    expect(await adapter.recheck({ offerId: offer!.offerId, searchId: 's' }, { ...ctx(), userId })).toMatchObject({ status: 'available', offer: { sellAmountMinor: 90_750 } })
  })

  it('SELL-03 a REMAINING count of 1 is shown as limited, and a count of 0 hides the plan', async () => {
    await ingestStock([stock('DBL', 'BAR', 20, 1), stock('DBL', 'BAR', 21, 1)])
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await promote()
    expect(forPlan(await search(), planA)).toMatchObject({ availability: 'limited', available: true })
    await ingestStock([stock('DBL', 'BAR', 20, 0), stock('DBL', 'BAR', 21, 0)])
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await promote()
    expect(forPlan(await search(), planA)).toBeUndefined()
    await ingestStock([stock('DBL', 'BAR', 20, 4), stock('DBL', 'BAR', 21, 4)])
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await promote()
    expect(forPlan(await search(), planA)).toMatchObject({ availability: 'available' })
  })

  it('SELL-04 room-wide stock lands in the pool: two plans share one unit, so both show limited and a sold unit hides both', async () => {
    await ingestRates([rate('TWN', 'P1', 20, 30_000), rate('TWN', 'P1', 21, 30_000), rate('TWN', 'P2', 20, 35_000), rate('TWN', 'P2', 21, 35_000)])
    await ingestStock([stock('TWN', null, 20, 1), stock('TWN', null, 21, 1)])
    const out = await promote()
    expect(out).toMatchObject({ status: 'APPLIED', poolNightsPromoted: 2 })
    let list = await search()
    expect(forPlan(list, planP1)).toMatchObject({ availability: 'limited', available: true })
    expect(forPlan(list, planP2)).toMatchObject({ availability: 'limited', available: true })
    await owner.inventoryPoolDay.updateMany({ where: { tenantId, poolId }, data: { sold: 1 } })
    list = await search()
    expect(forPlan(list, planP1)).toBeUndefined()
    expect(forPlan(list, planP2)).toBeUndefined()
  })

  it('SELL-05 a plan whose profile or plan flag fails the tax rule is never promoted, so it is never sold', async () => {
    await ingestRates([rate('TAX', 'N', 20, 20_000), rate('TAX', 'N', 21, 20_000)])
    await ingestStock([stock('TAX', 'N', 20, 5), stock('TAX', 'N', 21, 5)])
    const out = await promote()
    expect(out.summary).toMatchObject({ PLAN_TAX_FLAG_NOT_SET: 2 })
    expect(forPlan(await search(), planNoTax)).toBeUndefined()
  })

  it('SELL-06 a held batch changes nothing a buyer sees: the previous price keeps selling', async () => {
    await ingestRates([rate('DBL', 'BAR', 20, 99_999), rate('DBL', 'BAR', 21, 41_250)])
    await ingestStock([stock('DBL', 'BAR', 20, 4), stock('DBL', 'BAR', 21, 4)])
    expect(await promote()).toMatchObject({ status: 'HELD' })
    expect(forPlan(await search(), planA)).toMatchObject({ netAmountMinor: 82_500, sellAmountMinor: 90_750 })
  })

  it('SELL-07 a feed that stops arriving fails closed: expired promoted stock hides the offer', async () => {
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await ingestStock([stock('DBL', 'BAR', 20, 4), stock('DBL', 'BAR', 21, 4)])
    await promote()
    expect(forPlan(await search(), planA)).toBeDefined()
    // Time passes without a new feed: the row ages past its expiry (the database refuses an expiry before receipt, so receipt ages with it).
    await owner.dailyAvailability.updateMany({ where: { tenantId, ratePlanId: planA }, data: { sourceUpdatedAt: new Date(Date.now() - 7_200_000), receivedAt: new Date(Date.now() - 7_200_000), freshUntil: new Date(Date.now() - 1000) } })
    expect(forPlan(await search(), planA)).toBeUndefined()
  })

  it('SELL-08 a night the complete feed drops is closed and removes every stay through it, while a stay avoiding it still sells', async () => {
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    await ingestStock([stock('DBL', 'BAR', 20, 4), stock('DBL', 'BAR', 21, 4)])
    await promote()
    expect(forPlan(await search(), planA)).toBeDefined()
    await ingestStock([stock('DBL', 'BAR', 20, 4)]) // night 21 no longer mentioned
    await ingestRates([rate('DBL', 'BAR', 20, 41_250), rate('DBL', 'BAR', 21, 41_250)])
    expect(await promote()).toMatchObject({ nightsClosed: 1 })
    expect(forPlan(await search(), planA)).toBeUndefined()
    const one = await adapter.search({ ...criteria(), checkOut: iso(21) }, ctx())
    expect(forPlan(one.offers.flatMap((h) => h.rooms.flatMap((r) => r.rates)), planA)).toMatchObject({ available: true })
  })
})
