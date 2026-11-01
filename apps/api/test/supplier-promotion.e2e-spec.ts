import { randomBytes } from 'crypto'
import type { IngestAllotment, IngestRate, IngestResult } from '@bedbanks/connectors-core'
import { PrismaService } from '../src/database/prisma.service'
import { PROMOTE_PROBES, certifyPromoteRole, deprovisionPromoteRole, promoteGrantStatements, provisionPromoteRole } from '../src/database/supplier-promotion-role'
import { IngestProfileRegistry } from '../src/supplier-ingest/ingest-profile'
import { persistAllotments, persistRates, type PersistScope } from '../src/supplier-ingest/ingest-persistence'
import { SupplierPromotionDatabase } from '../src/supplier-promotion/supplier-promotion.database'
import { PromotionRefused, SupplierPromotionService } from '../src/supplier-promotion/supplier-promotion.service'

jest.setTimeout(180_000)

/** ADR 0084: ingested observations promoted into contracted rates, availability and pool capacity, as the narrow promotion login, against PostgreSQL. */
describe('supplier promotion under its narrow database role (ADR 0084)', () => {
  const owner = new PrismaService()
  const suffix = `promo-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const loginRole = `fbeds_promote_t${randomBytes(4).toString('hex')}`
  const profiles = new IngestProfileRegistry()
  let database: SupplierPromotionDatabase
  let service: SupplierPromotionService
  let tenantId = '', otherTenantId = '', supplierId = '', connectorId = '', hotelId = '', poolId = ''
  let planA = '', planC = '', planP1 = '', planP2 = ''
  const roomIds: Record<string, string> = {}
  const day = (n: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + n * 86_400_000
  const iso = (n: number) => new Date(day(n)).toISOString().slice(0, 10)
  let clock = 0
  const nextNow = () => new Date(Date.now() + 1000 * ++clock)

  profiles.register({ key: 'promo-feed', format: 'json', amountBasis: 'NET', allotmentSemantics: 'REMAINING', coverageDays: 30, freshnessMs: 3_600_000, specs: { RATES: { recordPath: 'a[]', fields: {} }, ALLOTMENTS: { recordPath: 'a[]', fields: {} } } })
  profiles.register({ key: 'promo-undeclared', format: 'json', freshnessMs: 3_600_000, specs: { RATES: { recordPath: 'a[]', fields: {} } } })

  const rate = (room: string, plan: string, night: number, net: number, extra: Partial<IngestRate> = {}): IngestRate => ({ supplierHotelCode: 'H1', supplierRoomCode: room, supplierRatePlanCode: plan, boardCode: 'BB', stayDate: iso(night), currency: 'AED', netMinor: net, taxesIncluded: true, minStay: null, maxStay: null, closedToArrival: false, closedToDeparture: false, ...extra })
  const stock = (room: string, plan: string | null, night: number, available: number | null, extra: Partial<IngestAllotment> = {}): IngestAllotment => ({ supplierHotelCode: 'H1', supplierRoomCode: room, supplierRatePlanCode: plan, stayDate: iso(night), mode: 'ALLOTMENT', available, stopSell: false, releaseDays: null, ...extra })
  const done = <T,>(accepted: T[]): IngestResult<T> => ({ accepted, rejected: [], extracted: accepted.length, status: 'COMPLETE' })
  let delivery = 0
  /** Ingest a delivery as the ingestion step would (observations + run), using the owner connection: this test is about promotion. */
  const ingestRates = (rows: IngestRate[], at = nextNow()) => owner.withTenant(tenantId, (tx) => persistRates(tx, scope(`rates-${++delivery}-${suffix}`.slice(0, 60), at), done(rows)))
  const ingestStock = (rows: IngestAllotment[], at = nextNow()) => owner.withTenant(tenantId, (tx) => persistAllotments(tx, scope(`stock-${++delivery}-${suffix}`.slice(0, 60), at), done(rows)))
  const scope = (idempotencyKey: string, receivedAt: Date): PersistScope => ({ tenantId, supplierId, connectorId, idempotencyKey, actorUserId: null, receivedAt, sourceUpdatedAt: null, freshUntil: new Date(receivedAt.getTime() + 3_600_000) })
  let promo = 0
  const promote = (patch: Record<string, unknown> = {}) => service.promote({ tenantId, supplierId, connectorId, profileKey: 'promo-feed', idempotencyKey: `promotion-${++promo}-${suffix}`, now: new Date(Date.now() + 5000 * 60), ...patch } as never)
  const planRate = (planId: string, night: number) => owner.dailyRate.findFirst({ where: { tenantId, ratePlanId: planId, stayDate: new Date(day(night)) } })
  const avail = (planId: string, night: number) => owner.dailyAvailability.findFirst({ where: { tenantId, ratePlanId: planId, stayDate: new Date(day(night)) } })

  async function plan(room: string, code: string, extra: Record<string, unknown> = {}) {
    const board = await owner.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })
    const contract = await owner.contract.create({ data: { tenantId, supplierId, code: `${suffix}-${code}`, status: 'ACTIVE', validFrom: new Date(day(-5)), validTo: new Date(day(300)), settlementCurrency: 'AED' } as never })
    return (await owner.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: roomIds[room], boardBasisId: board.id, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', taxesIncluded: true, ...extra } })).id
  }
  /** Approved mapping chain, created as the owner so the test does not depend on the governance UI. */
  async function mapRoom(supplierHotelMappingId: string, supplierRoomId: string, room: string) {
    return (await owner.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId, hotelId, supplierRoomId, roomTypeId: roomIds[room], status: 'MAPPED' } })).id
  }
  const mapPlan = (supplierRoomMappingId: string, supplierRatePlanCode: string, ratePlanId: string) => owner.supplierRatePlanMapping.create({ data: { tenantId, supplierRoomMappingId, supplierRatePlanCode, ratePlanId, status: 'MAPPED' } })

  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionPromoteRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString()); login.username = loginRole; login.password = password
    database = new SupplierPromotionDatabase({ SUPPLIER_PROMOTION_DATABASE_URL: login.toString(), DATABASE_URL: ownerUrl.toString() })
    service = new SupplierPromotionService(database, profiles)
    narrowUrl = login.toString()

    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    otherTenantId = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} LLC`, displayName: 'Promo Supplier', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    connectorId = (await owner.connectorDefinition.create({ data: { tenantId, supplierId, type: 'CHANNEL_MANAGER', status: 'ACTIVE', name: 'cm', version: '0.0.1' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId, name: `${suffix} H`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4 } })).id
    for (const code of ['DLX', 'STD', 'SUP']) roomIds[code] = (await owner.roomType.create({ data: { hotelId, name: code, code, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })).id
    planA = await plan('DLX', 'A'); planC = await plan('SUP', 'C', { taxesIncluded: false })
    poolId = (await owner.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Standard', createdById: 'u' } })).id
    planP1 = await plan('STD', 'P1', { inventoryPoolId: poolId }); planP2 = await plan('STD', 'P2', { inventoryPoolId: poolId })
    const hm = (await owner.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: 'H1', status: 'MAPPED' } })).id
    const dbl = await mapRoom(hm, 'DBL', 'DLX'); const twn = await mapRoom(hm, 'TWN', 'STD'); const sui = await mapRoom(hm, 'SUI', 'SUP')
    await mapPlan(dbl, 'BAR', planA); await mapPlan(twn, 'P1', planP1); await mapPlan(twn, 'P2', planP2); await mapPlan(sui, 'X', planC)
  })
  let narrowUrl = ''

  afterAll(async () => {
    await database.onModuleDestroy()
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('fbeds.ingest_erasure', 'on', true)`
      for (const id of [tenantId, otherTenantId]) {
        for (const table of ['SupplierPromotionRun', 'SupplierRateObservation', 'SupplierAllotmentObservation', 'SupplierCancellationObservation', 'SupplierIngestRun', 'AuditEvent', 'DailyRate', 'DailyAvailability', 'InventoryPoolDay', 'SupplierRatePlanMapping', 'SupplierRoomMapping', 'SupplierHotelMapping']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('UPDATE "RatePlan" SET inventory_pool_id = NULL WHERE tenant_id = $1', id)
        for (const table of ['RatePlan', 'Contract', 'InventoryPool', 'BoardBasis', 'ConnectorDefinition']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = $1)', id)
        for (const table of ['Hotel', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      }
    })
    await deprovisionPromoteRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('PR-01 the login passes the catalogue verifier and every privilege probe, and holds no restriction, sold or held privilege', async () => {
    const { PrismaClient } = await import('@prisma/client')
    const narrow = new PrismaClient({ datasourceUrl: narrowUrl })
    try {
      const report = await certifyPromoteRole(narrow)
      expect(report.role.failures).toEqual([])
      expect(report.probes.filter((p) => !p.ok)).toEqual([])
      expect(report.probes).toHaveLength(PROMOTE_PROBES.length)
      const grants = promoteGrantStatements().join('\n')
      expect(grants).not.toMatch(/UPDATE \([^)]*(min_stay|closed_to|"sold"|"held")/)
      expect(grants).not.toMatch(/GRANT [A-Z, ]*(DELETE|TRUNCATE)/)
    } finally { await narrow.$disconnect() }
  })

  it('PR-02 promotes NET rates, plan stock and pool capacity; blocks what the rules block; writes run evidence and a SYSTEM audit; replays idempotently', async () => {
    await ingestRates([rate('DBL', 'BAR', 5, 41250), rate('DBL', 'BAR', 6, 40000), rate('DBL', 'BAR', 7, 42000), rate('SUI', 'X', 5, 90000), rate('DBL', 'BAR', 8, 50000, { taxesIncluded: null }), rate('DBL', 'BAR', 9, 50000, { currency: 'USD' })])
    await ingestStock([
      stock('DBL', 'BAR', 5, 4, { releaseDays: 2 }), stock('DBL', 'BAR', 6, 3), stock('DBL', 'BAR', 7, 0, { stopSell: true }),
      stock('TWN', null, 5, 5), stock('TWN', null, 6, 6),            // room-wide -> pool
      stock('TWN', 'P1', 7, 9),                                       // plan-level on a pooled plan -> blocked
      stock('SUI', null, 5, 2),                                       // room-wide, plan not pooled -> NEEDS_POOL
    ])
    const out = await promote()
    expect(out).toMatchObject({ status: 'APPLIED', replayed: false, ratesPromoted: 4 - 1 + 0, nightsPromoted: 3 + 2 * 2, poolNightsPromoted: 2 })
    // The resolver reports an unstated tax basis and a currency mismatch before the promotion rules see them.
    expect(out.summary).toMatchObject({ PLAN_TAX_FLAG_NOT_SET: 1, TAX_BASIS_UNSTATED: 1, CURRENCY_MISMATCH: 1, POOLED_PLAN_STOCK_NEEDS_ROOM_WIDE: 1, NEEDS_POOL: 1 })

    const r5 = await planRate(planA, 5)
    expect(r5).toMatchObject({ amountMinor: 41250n, amountBasis: 'NET', currency: 'AED', occupancy: 2 })
    expect(await planRate(planC, 5)).toBeNull()
    const a5 = await avail(planA, 5); const a7 = await avail(planA, 7)
    expect(a5).toMatchObject({ allotment: 4, sold: 0, held: 0, inventoryMode: 'ALLOTMENT', source: 'SUPPLIER_FEED', releaseDays: 2, minStay: 1, closedToArrival: false, closedToDeparture: false })
    expect(a5?.freshUntil && a5.freshUntil > new Date()).toBe(true)
    expect(a7).toMatchObject({ stopSell: true })
    expect(await owner.inventoryPoolDay.findMany({ where: { tenantId, poolId }, orderBy: { stayDate: 'asc' } })).toMatchObject([{ capacity: 5, sold: 0, held: 0, source: 'SUPPLIER_FEED' }, { capacity: 6 }])
    expect(await avail(planP1, 5)).toMatchObject({ allotment: 0, inventoryMode: 'ALLOTMENT', source: 'SUPPLIER_FEED' })
    expect(await avail(planP2, 6)).toMatchObject({ allotment: 0 })

    const run = await owner.supplierPromotionRun.findUniqueOrThrow({ where: { id: out.runId } })
    expect(run).toMatchObject({ status: 'APPLIED', profileKey: 'promo-feed', ratesConsidered: 6 })
    const audit = await owner.auditEvent.findMany({ where: { tenantId, entityId: out.runId } })
    expect(audit).toMatchObject([{ actorType: 'SYSTEM', userId: null, action: 'supplier.promotion.applied', entityType: 'supplier_promotion_run' }])

    const before = await owner.dailyRate.count({ where: { tenantId } })
    const again = await promote({ idempotencyKey: `promotion-1-${suffix}` })
    expect(again).toMatchObject({ runId: out.runId, replayed: true })
    expect(await owner.dailyRate.count({ where: { tenantId } })).toBe(before)
    expect(await owner.supplierPromotionRun.count({ where: { tenantId } })).toBe(1)
  })

  it('PR-03 REMAINING stock respects sold and held: allotment = sold + held + count, never below what is committed', async () => {
    await owner.dailyAvailability.updateMany({ where: { tenantId, ratePlanId: planA, stayDate: new Date(day(5)) }, data: { sold: 2, held: 1 } })
    await ingestStock([stock('DBL', 'BAR', 5, 4), stock('DBL', 'BAR', 6, 3), stock('DBL', 'BAR', 7, 0, { stopSell: true }), stock('DBL', 'BAR', 8, 2)])
    await ingestRates([rate('DBL', 'BAR', 5, 41250), rate('DBL', 'BAR', 6, 40000), rate('DBL', 'BAR', 7, 42000)])
    const out = await promote()
    expect(out.status).toBe('APPLIED')
    expect(await avail(planA, 5)).toMatchObject({ allotment: 7, sold: 2, held: 1 })
  })

  it('PR-04 a person\'s stop-sell is not reopened by the feed; the night is skipped, not the batch', async () => {
    await owner.dailyAvailability.updateMany({ where: { tenantId, ratePlanId: planA, stayDate: new Date(day(6)) }, data: { stopSell: true, source: 'ADMIN' } })
    await ingestStock([stock('DBL', 'BAR', 5, 5), stock('DBL', 'BAR', 6, 9), stock('DBL', 'BAR', 7, 0, { stopSell: true }), stock('DBL', 'BAR', 8, 2)])
    const out = await promote()
    expect(out.summary).toMatchObject({ SKIPPED_MANUAL_CLOSE: 1 })
    expect(await avail(planA, 6)).toMatchObject({ stopSell: true, source: 'ADMIN', allotment: 3 })
    expect(await avail(planA, 5)).toMatchObject({ allotment: 8, source: 'SUPPLIER_FEED' })
  })

  it('PR-05 a complete feed that no longer mentions a promoted night closes it inside the declared window, and only those the feed promoted', async () => {
    // Night 5 is mentioned; 6 is a person\'s close (source ADMIN, not feed-promoted); 7 was already closed; 8 was promoted open by the feed and is now omitted.
    await ingestStock([stock('DBL', 'BAR', 5, 5)])
    const out = await promote()
    expect(out.summary).toMatchObject({ NIGHTS_CLOSED_OMITTED: 1 })
    expect(await avail(planA, 8)).toMatchObject({ inventoryMode: 'CLOSED', source: 'SUPPLIER_FEED' })
    expect(await avail(planA, 6)).toMatchObject({ source: 'ADMIN', stopSell: true })
    expect(await avail(planA, 5)).toMatchObject({ inventoryMode: 'ALLOTMENT' })
  })

  it('PR-06 a batch with a night moving more than 30% is HELD whole: nothing is written, evidence and audit say why', async () => {
    const rateBefore = await planRate(planA, 5)
    const stockBefore = await avail(planA, 5)
    await ingestRates([rate('DBL', 'BAR', 5, 99_999), rate('DBL', 'BAR', 6, 40000), rate('DBL', 'BAR', 7, 42000)])
    await ingestStock([stock('DBL', 'BAR', 5, 1)])
    const out = await promote()
    expect(out).toMatchObject({ status: 'HELD', ratesPromoted: 0, nightsPromoted: 0, nightsClosed: 0 })
    expect(out.summary).toMatchObject({ HELD_LARGE_PRICE_MOVE: 1, HELD_LARGE_MOVES: 1 })
    expect((await planRate(planA, 5))?.amountMinor).toBe(rateBefore?.amountMinor)
    expect((await avail(planA, 5))?.allotment).toBe(stockBefore?.allotment)
    expect(await owner.auditEvent.count({ where: { tenantId, entityId: out.runId, action: 'supplier.promotion.held' } })).toBe(1)
  })

  it('PR-07 a profile that does not declare NET or stock semantics promotes nothing it cannot justify', async () => {
    await ingestRates([rate('DBL', 'BAR', 5, 41250)])
    const out = await promote({ profileKey: 'promo-undeclared' })
    expect(out).toMatchObject({ status: 'NOTHING_TO_PROMOTE', ratesPromoted: 0 })
    expect(out.summary).toMatchObject({ BASIS_NOT_NET: 1 })
    await expect(promote({ profileKey: 'nope-profile' })).rejects.toBeInstanceOf(PromotionRefused)
    await expect(promote({ idempotencyKey: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('PR-08 the role is refused outside its lane and another tenant context sees nothing', async () => {
    const refused = { response: { code: 'SUPPLIER_PROMOTION_UNAVAILABLE' } }
    for (const sql of [
      `UPDATE "DailyAvailability" SET "min_stay" = 9`, `UPDATE "DailyAvailability" SET "sold" = 0`, `UPDATE "InventoryPoolDay" SET "held" = 0`, `DELETE FROM "DailyRate"`,
      `UPDATE "RatePlan" SET "status" = 'SUSPENDED'`, `UPDATE "SupplierPromotionRun" SET "status" = 'HELD'`,
    ]) await expect(database.withTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql))).rejects.toMatchObject(refused)
    await expect(database.withTenant(tenantId, (tx) => tx.auditEvent.createMany({ data: [{ tenantId, userId: null, actorType: 'SYSTEM', action: 'booking.finance.posted', entityType: 'booking', entityId: 'x', payload: {} }] }))).rejects.toThrow(/row-level security|violates/i)
    expect(Number(await database.withTenant(otherTenantId, async (tx) => (await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT (SELECT count(*) FROM "DailyRate") + (SELECT count(*) FROM "SupplierPromotionRun") AS n`))[0].n))).toBe(0)
    const unconfigured = new SupplierPromotionDatabase({})
    await expect(unconfigured.withTenant(tenantId, async () => 1)).rejects.toMatchObject({ response: { code: 'SUPPLIER_PROMOTION_UNAVAILABLE' } })
  })
})
