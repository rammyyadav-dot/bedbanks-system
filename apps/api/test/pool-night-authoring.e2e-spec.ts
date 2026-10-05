import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { POOL_NIGHT_ACTION, authorPoolNights } from '../src/inventory/pool-night-authoring'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')
jest.setTimeout(120_000)

/** The owner-run tool creates missing pool nights safely; the strict API role still cannot. */
describe('pool night authoring (PostgreSQL, disposable)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `pn-${Date.now()}-${randomBytes(3).toString('hex')}`
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (n: number) => new Date(base + n * 86_400_000).toISOString().slice(0, 10)
  let tenantA = '', tenantB = '', poolId = '', hotelId = '', userId = ''
  const req = (over: Record<string, unknown> = {}) => ({ tenantId: tenantA, poolId, from: day(10), to: day(14), capacity: 6, reason: 'Hotel confirmed stock', actor: 'ops test', ...over })
  const nights = () => owner.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' } })
  const audits = () => owner.auditEvent.count({ where: { tenantId: tenantA, action: POOL_NIGHT_ACTION } })

  beforeAll(async () => {
    tenantA = (await owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const supplier = await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} h`, externalRef: `h-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    hotelId = hotel.id
    userId = (await owner.user.create({ data: { email: `${suffix}@example.test`, passwordHash: 'x', status: 'ACTIVE' } })).id
    poolId = (await owner.inventoryPool.create({ data: { tenantId: tenantA, hotelId, supplierId: supplier.id, name: 'Pool', createdById: userId } })).id
    await owner.inventoryPoolDay.create({ data: { tenantId: tenantA, poolId, stayDate: new Date(day(12)), capacity: 9, sold: 2, held: 1 } })
  })
  afterAll(async () => {
    await owner.auditEvent.deleteMany({ where: { tenantId: tenantA } }); await owner.inventoryPoolDay.deleteMany({ where: { tenantId: tenantA } }); await owner.inventoryPool.deleteMany({ where: { tenantId: tenantA } })
    await owner.hotel.deleteMany({ where: { tenantId: tenantA } }); await owner.supplier.deleteMany({ where: { tenantId: tenantA } }); await owner.user.deleteMany({ where: { id: userId } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }); await owner.$disconnect()
  })

  it('PN-01 preview writes nothing and reports exactly what would be created', async () => {
    const before = await nights(); const a0 = await audits()
    const r = await authorPoolNights(owner, req(), { apply: false })
    expect(r).toMatchObject({ applied: false, created: 0 }); expect(r.plan.create).toEqual([day(10), day(11), day(13), day(14)]); expect(r.plan.existing).toEqual([day(12)])
    expect(await nights()).toEqual(before); expect(await audits()).toBe(a0)
  })

  it('PN-02 apply creates only the missing nights, leaves the existing night (sold, held, capacity) untouched, and writes one audit event', async () => {
    const preview = await authorPoolNights(owner, req(), { apply: false })
    const r = await authorPoolNights(owner, req(), { apply: true, expectedFingerprint: preview.plan.fingerprint })
    expect(r).toMatchObject({ applied: true, created: 4 })
    const rows = await nights()
    expect(rows.map((n) => [n.stayDate.toISOString().slice(0, 10), n.capacity, n.sold, n.held, n.source])).toEqual([[day(10), 6, 0, 0, 'ADMIN'], [day(11), 6, 0, 0, 'ADMIN'], [day(12), 9, 2, 1, 'ADMIN'], [day(13), 6, 0, 0, 'ADMIN'], [day(14), 6, 0, 0, 'ADMIN']])
    expect(await audits()).toBe(1)
    const ev = await owner.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA, action: POOL_NIGHT_ACTION } })
    expect(ev).toMatchObject({ actorType: 'SYSTEM', entityType: 'hotel', entityId: hotelId, payload: expect.objectContaining({ created: 4, skippedExisting: 1, operator: 'ops test', reason: 'Hotel confirmed stock' }) })
  })

  it('PN-03 re-running is idempotent: nothing created, no second audit event', async () => {
    const r = await authorPoolNights(owner, req(), { apply: true })
    expect(r).toMatchObject({ applied: true, created: 0 }); expect(await nights()).toHaveLength(5); expect(await audits()).toBe(1)
  })

  it('PN-04 refuses a stale fingerprint, a wrong tenant, an archived pool and past nights, writing nothing', async () => {
    const a0 = await audits()
    await expect(authorPoolNights(owner, req({ from: day(20), to: day(21) }), { apply: true, expectedFingerprint: 'f'.repeat(64) })).rejects.toThrow(/changed since the preview/)
    await expect(authorPoolNights(owner, req({ tenantId: tenantB }), { apply: false })).rejects.toThrow(/pool not found/)
    const past = await authorPoolNights(owner, req({ from: day(-3), to: day(-1) }), { apply: true })
    expect(past).toMatchObject({ created: 0 }); expect(past.plan.past).toHaveLength(3)
    await owner.inventoryPool.update({ where: { id: poolId }, data: { status: 'ARCHIVED', archivedAt: new Date() } })
    try { await expect(authorPoolNights(owner, req({ from: day(30), to: day(30) }), { apply: true })).rejects.toThrow(/not ACTIVE/) } finally { await owner.inventoryPool.update({ where: { id: poolId }, data: { status: 'ACTIVE', archivedAt: null } }) }
    expect(await nights()).toHaveLength(5); expect(await audits()).toBe(a0)
  })

  it('PN-05 the strict API role still cannot create pool nights (the privileged path stays privileged)', async () => {
    const pw = randomBytes(24).toString('hex'); await provisionApiRuntimeRole(owner, { password: pw })
    const u = new URL(ownerUrl); u.username = API_RUNTIME_LOGIN_ROLE; u.password = pw
    const api = new PrismaClient({ datasourceUrl: u.toString() })
    try {
      await expect(api.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`; await tx.$executeRaw`INSERT INTO "InventoryPoolDay" ("id","tenant_id","pool_id","stay_date","capacity") VALUES (gen_random_uuid(), ${tenantA}, ${poolId}, ${day(40)}::date, 1)` })).rejects.toThrow(/permission denied/)
    } finally { await api.$disconnect() }
    expect(await nights()).toHaveLength(5)
  })
})
