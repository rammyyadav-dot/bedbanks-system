import { PrismaClient } from '@prisma/client'
import { deprovisionRatePlanCloneRole, provisionRatePlanCloneRole, RATE_PLAN_CLONE_LOGIN_ROLE, verifyRatePlanCloneRole } from '../src/database/rate-plan-clone-role'
import { certifyRatePlanCloneRole } from '../src/database/rate-plan-clone-verify'
import { RatePlanCloneDatabase } from '../src/supply/rate-plan-clone-database'

/**
 * ADR 0057, S8: the clone writer against a disposable PostgreSQL. The owner client arranges and observes; the writes under test go through the
 * real `fbeds_rateplan_cloner` login. The point of this suite is that DRAFT-only is a DATABASE rule, not application behaviour.
 */
const prisma = new PrismaClient()
const ownerUrl = process.env.DATABASE_URL as string
const DAY = 86_400_000
const day = (offset: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offset * DAY)

describe('Rate plan clone role', () => {
  const suffix = `clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = `Pw${'y'.repeat(40)}${Math.random().toString(36).slice(2, 10)}`
  let cloneUrl: string
  let login: PrismaClient
  let tenantId: string, otherTenantId: string
  let source: { id: string; contractId: string; roomTypeId: string; boardBasisId: string }
  let poolId: string
  let n = 0

  /** One INSERT as the clone login, in a tenant-scoped transaction, with the columns a clone writes. */
  const insertAs = (client: PrismaClient, tenant: string, row: { status?: string; pool?: string | null; tenant?: string }) => client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenant}', true)`)
    await tx.$executeRawUnsafe(`INSERT INTO "RatePlan" (id, tenant_id, contract_id, room_type_id, board_basis_id, code, status, occupancy, currency, inventory_pool_id, updated_at)
      VALUES ('${suffix}-ins-${++n}', '${row.tenant ?? tenant}', '${source.contractId}', '${source.roomTypeId}', '${source.boardBasisId}', '${suffix}-INS-${n}', '${row.status ?? 'DRAFT'}'::"RatePlanStatus", 2, 'AED', ${row.pool ? `'${row.pool}'` : 'NULL'}, now())`)
  })

  beforeAll(async () => {
    await prisma.$connect()
    await provisionRatePlanCloneRole(prisma, { password })
    const url = new URL(ownerUrl); url.username = RATE_PLAN_CLONE_LOGIN_ROLE; url.password = password; cloneUrl = url.toString()
    login = new PrismaClient({ datasourceUrl: cloneUrl })
    tenantId = (await prisma.tenant.create({ data: { name: `${suffix}-a`, slug: `${suffix}-a` } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 4 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Room', code: suffix, maxAdults: 2, maxOccupancy: 2 } })
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: `${suffix} board` } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId: supplier.id, code: suffix, status: 'ACTIVE', validFrom: day(-30), validTo: day(300), settlementCurrency: 'AED' } })
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test` } })
    poolId = (await prisma.inventoryPool.create({ data: { tenantId, hotelId: hotel.id, supplierId: supplier.id, name: 'Pool', createdById: user.id } })).id
    source = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: `${suffix}-SRC`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
  }, 60000)

  afterAll(async () => {
    await login?.$disconnect()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlan.updateMany({ where: { tenantId: tenants }, data: { derivedFromId: null, derivedMode: null, derivedAdjustment: null } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
    await prisma.inventoryPool.deleteMany({ where: { tenantId: tenants } })
    await prisma.contract.deleteMany({ where: { tenantId: tenants } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: tenants } } })
    await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
    await prisma.user.deleteMany({ where: { email: `${suffix}@example.test` } })
    await prisma.tenant.deleteMany({ where: { id: tenants } })
    await deprovisionRatePlanCloneRole(prisma).catch(() => undefined)
    await prisma.$disconnect()
  })

  it('the role verifier and every privilege probe pass as the clone login', async () => {
    const cert = await certifyRatePlanCloneRole(login)
    expect(cert.role.failures).toEqual([])
    expect(cert.probes.filter((p) => !p.ok)).toEqual([])
    expect(cert.ok).toBe(true)
  })

  it('provisioning twice converges, and the verifier fails if the DRAFT-only trigger is gone', async () => {
    await provisionRatePlanCloneRole(prisma, { password })
    expect((await verifyRatePlanCloneRole(login)).ok).toBe(true)
    await prisma.$executeRawUnsafe(`ALTER TABLE "RatePlan" DISABLE TRIGGER "RatePlan_clone_guard"`)
    try { expect((await verifyRatePlanCloneRole(login)).failures).toContain('the DRAFT-only guard trigger is missing or disabled') } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "RatePlan" ENABLE TRIGGER "RatePlan_clone_guard"`) }
    expect((await verifyRatePlanCloneRole(login)).ok).toBe(true)
  })

  it('may insert a DRAFT plan with no pool in its own tenant', async () => {
    await insertAs(login, tenantId, {})
    const row = await prisma.ratePlan.findFirstOrThrow({ where: { code: `${suffix}-INS-${n}` } })
    expect(row).toMatchObject({ status: 'DRAFT', inventoryPoolId: null })
  })

  it('may insert a DRAFT derived from a same-shape parent, and the database refuses a parent of another shape (ADR 0058, S10b)', async () => {
    const insertDerived = (code: string, parent: string, occupancy: number) => login.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`)
      await tx.$executeRawUnsafe(`INSERT INTO "RatePlan" (id, tenant_id, contract_id, room_type_id, board_basis_id, code, status, occupancy, currency, derived_from_id, derived_mode, derived_adjustment, updated_at)
        VALUES ('${suffix}-${code}', '${tenantId}', '${source.contractId}', '${source.roomTypeId}', '${source.boardBasisId}', '${suffix}-${code}', 'DRAFT'::"RatePlanStatus", ${occupancy}, 'AED', '${parent}', 'PERCENT_BP'::"DerivedRateMode", -1000, now())`)
    })
    await insertDerived('DERIVED-OK', source.id, 2)
    expect(await prisma.ratePlan.findFirstOrThrow({ where: { code: `${suffix}-DERIVED-OK` } })).toMatchObject({ status: 'DRAFT', derivedFromId: source.id, derivedMode: 'PERCENT_BP', derivedAdjustment: -1000 })
    await expect(insertDerived('DERIVED-BAD', source.id, 1)).rejects.toThrow(/DERIVED_PARENT_MISMATCH/)
    const child = await prisma.ratePlan.findFirstOrThrow({ where: { code: `${suffix}-DERIVED-OK` } })
    await expect(insertDerived('DERIVED-DEEP', child.id, 2)).rejects.toThrow(/DERIVED_PARENT_IS_DERIVED/)
    expect(await prisma.ratePlan.count({ where: { code: { in: [`${suffix}-DERIVED-BAD`, `${suffix}-DERIVED-DEEP`] } } })).toBe(0)
  })

  it('can never insert a plan that is not a DRAFT, whatever the application does: the database refuses', async () => {
    for (const status of ['ACTIVE', 'SUSPENDED', 'EXPIRED']) {
      await expect(insertAs(login, tenantId, { status })).rejects.toThrow(/may only insert DRAFT plans/)
    }
    expect(await prisma.ratePlan.count({ where: { tenantId, code: { startsWith: `${suffix}-INS-` }, status: { not: 'DRAFT' } } })).toBe(0)
  })

  it('can never attach an inventory pool', async () => {
    await expect(insertAs(login, tenantId, { pool: poolId })).rejects.toThrow(/may not attach an inventory pool/)
  })

  it('row-level security still applies: another tenant\'s row, or no tenant, is refused', async () => {
    await expect(insertAs(login, tenantId, { tenant: otherTenantId })).rejects.toThrow(/row-level security/)
    await expect(login.$executeRawUnsafe(`INSERT INTO "RatePlan" (id, tenant_id, contract_id, room_type_id, board_basis_id, code, status, occupancy, currency, updated_at)
      VALUES ('${suffix}-notenant', '${tenantId}', '${source.contractId}', '${source.roomTypeId}', '${source.boardBasisId}', '${suffix}-NT', 'DRAFT', 2, 'AED', now())`)).rejects.toThrow()
  })

  it('cannot update, delete, or touch rates, even on a plan it just created', async () => {
    const own = await prisma.ratePlan.findFirstOrThrow({ where: { code: `${suffix}-INS-1` } })
    const asLogin = (sql: string) => login.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`); await tx.$executeRawUnsafe(sql) })
    await expect(asLogin(`UPDATE "RatePlan" SET status = 'ACTIVE' WHERE id = '${own.id}'`)).rejects.toThrow(/permission denied/)
    await expect(asLogin(`UPDATE "RatePlan" SET code = 'x' WHERE id = '${own.id}'`)).rejects.toThrow(/permission denied/)
    await expect(asLogin(`DELETE FROM "RatePlan" WHERE id = '${own.id}'`)).rejects.toThrow(/permission denied/)
    await expect(asLogin(`INSERT INTO "DailyRate" (id) VALUES ('x')`)).rejects.toThrow(/permission denied/)
    expect((await prisma.ratePlan.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('DRAFT')
  })

  it('does not constrain anyone else: the owner can still insert an ACTIVE plan (the trigger only binds the clone role)', async () => {
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: source.contractId, roomTypeId: source.roomTypeId, boardBasisId: source.boardBasisId, code: `${suffix}-OWNER`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
    expect(plan.status).toBe('ACTIVE')
  })

  it('the application connection: configured only with a credential different from DATABASE_URL, sanitized 503 when unusable, no fallback', async () => {
    expect(new RatePlanCloneDatabase({ DATABASE_URL: ownerUrl }).configured()).toBe(false)
    expect(new RatePlanCloneDatabase({ RATE_PLAN_CLONE_DATABASE_URL: ownerUrl, DATABASE_URL: ownerUrl }).configured()).toBe(false)
    const good = new RatePlanCloneDatabase({ RATE_PLAN_CLONE_DATABASE_URL: cloneUrl, DATABASE_URL: ownerUrl })
    expect(good.configured()).toBe(true)
    expect(await good.withTenant(tenantId, async (tx) => (await tx.ratePlan.findMany({ where: { tenantId }, select: { id: true } })).length)).toBeGreaterThan(0)
    await good.onModuleDestroy()
    const bad = new URL(cloneUrl); bad.password = 'wrong-password-wrong-password-wrong-password'
    const broken = new RatePlanCloneDatabase({ RATE_PLAN_CLONE_DATABASE_URL: bad.toString(), DATABASE_URL: ownerUrl })
    await expect(broken.withTenant(tenantId, async () => 1)).rejects.toMatchObject({ response: { code: 'RATE_PLAN_CLONE_UNAVAILABLE' } })
    await broken.onModuleDestroy()
  })
})
