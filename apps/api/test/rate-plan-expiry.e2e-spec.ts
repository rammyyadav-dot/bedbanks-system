import { PrismaClient } from '@prisma/client'
import { RatePlanOpsDatabase } from '../src/supply/rate-plan-ops-database'
import { RatePlanExpirySweeper } from '../src/supply/rate-plan-expiry-sweeper.service'
import { hotelToday } from '../src/supply/rate-plan-expiry'
import { deprovisionRatePlanOpsRole, provisionRatePlanOpsRole, RATE_PLAN_OPS_LOGIN_ROLE, verifyRatePlanOpsRole } from '../src/database/rate-plan-ops-role'
import { certifyRatePlanOpsRole } from '../src/database/rate-plan-ops-verify'

/**
 * ADR 0057, S9: the expiry sweeper, run for real against a disposable PostgreSQL through the real narrow lifecycle role.
 * The owner client arranges and observes; every write under test goes through `fbeds_rateplan_ops`.
 */
const prisma = new PrismaClient()
const ownerUrl = process.env.DATABASE_URL as string
const DAY = 86_400_000
// The sweeper judges plans in the hotel's calendar, so "today" here is the hotel's day. The fixtures' hotels are in Asia/Dubai; a UTC day is one day
// behind for them between 20:00 and 24:00 UTC, which made the last-sale-day plan expire on the first pass.
const HOTEL_TIME_ZONE = 'Asia/Dubai'
const day = (offset: number) => new Date(Date.parse(`${hotelToday(new Date(), HOTEL_TIME_ZONE)!}T00:00:00.000Z`) + offset * DAY)

describe('Rate plan expiry sweeper (lifecycle role)', () => {
  const suffix = `expiry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = `Pw${'x'.repeat(40)}${Math.random().toString(36).slice(2, 10)}`
  let opsUrl: string
  let ops: RatePlanOpsDatabase
  let tenantA: string, tenantB: string
  const ids: Record<string, string> = {}

  const mkTenant = async (name: string) => (await prisma.tenant.create({ data: { name: `${suffix}-${name}`, slug: `${suffix}-${name}` } })).id
  const mkWorld = async (tenantId: string, label: string, timeZone: string, contractValidTo: Date) => {
    const supplier = await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix}-${label}`, displayName: label, countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix}-${label} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone, contentStatus: 'COMPLETE', starRating: 4 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Room', code: `${label}-R`, maxAdults: 2, maxOccupancy: 2 } })
    const board = await prisma.boardBasis.create({ data: { tenantId, code: label.slice(0, 3).toUpperCase(), name: `${label} board` } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId: supplier.id, code: `${suffix}-${label}`, status: 'ACTIVE', validFrom: day(-400), validTo: contractValidTo, settlementCurrency: 'AED' } })
    return { room, board, contract }
  }
  const mkPlan = (tenantId: string, world: Awaited<ReturnType<typeof mkWorld>>, key: string, status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED', validTo: Date | null) =>
    prisma.ratePlan.create({ data: { tenantId, contractId: world.contract.id, roomTypeId: world.room.id, boardBasisId: world.board.id, code: `${suffix}-${key}`, status, occupancy: 2, currency: 'AED', validTo } }).then((plan) => { ids[key] = plan.id; return plan })
  const status = async (key: string) => (await prisma.ratePlan.findUniqueOrThrow({ where: { id: ids[key] } })).status
  const expiryEvents = (key: string) => prisma.auditEvent.findMany({ where: { entityId: ids[key], action: 'supply.rate_plan.status_changed' } })

  beforeAll(async () => {
    await prisma.$connect()
    await provisionRatePlanOpsRole(prisma, { password })
    const url = new URL(ownerUrl); url.username = RATE_PLAN_OPS_LOGIN_ROLE; url.password = password; opsUrl = url.toString()
    ops = new RatePlanOpsDatabase({ RATE_PLAN_OPS_DATABASE_URL: opsUrl, DATABASE_URL: ownerUrl })
    tenantA = await mkTenant('a'); tenantB = await mkTenant('b')
    const live = await mkWorld(tenantA, 'live', 'Asia/Dubai', day(200))
    const ended = await mkWorld(tenantA, 'ended', 'Asia/Dubai', day(-3))
    const nowhere = await mkWorld(tenantA, 'nowhere', 'Nowhere/Land', day(200))
    const other = await mkWorld(tenantB, 'other', 'Asia/Dubai', day(200))
    await mkPlan(tenantA, live, 'activeWindowEnded', 'ACTIVE', day(-2))
    await mkPlan(tenantA, live, 'suspendedWindowEnded', 'SUSPENDED', day(-5))
    await mkPlan(tenantA, live, 'activeInside', 'ACTIVE', day(30))
    await mkPlan(tenantA, live, 'activeNoWindow', 'ACTIVE', null)
    await mkPlan(tenantA, live, 'activeLastDay', 'ACTIVE', day(0))
    await mkPlan(tenantA, live, 'draftWindowEnded', 'DRAFT', day(-9))
    await mkPlan(tenantA, live, 'alreadyExpired', 'EXPIRED', day(-9))
    await mkPlan(tenantA, ended, 'activeContractEnded', 'ACTIVE', null)
    await mkPlan(tenantA, nowhere, 'badZone', 'ACTIVE', day(-2))
    await mkPlan(tenantB, other, 'otherTenantEnded', 'ACTIVE', day(-2))
  }, 60000)

  afterAll(async () => {
    await ops?.onModuleDestroy()
    const tenants = { in: [tenantA, tenantB] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
    await prisma.contract.deleteMany({ where: { tenantId: tenants } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: tenants } } })
    await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
    await prisma.tenant.deleteMany({ where: { id: tenants } })
    await deprovisionRatePlanOpsRole(prisma).catch(() => undefined)
    await prisma.$disconnect()
  })

  it('the lifecycle role may list tenants by id and status only, and its own verifier and probes pass', async () => {
    const login = new PrismaClient({ datasourceUrl: opsUrl })
    try {
      expect((await verifyRatePlanOpsRole(login)).failures).toEqual([])
      const cert = await certifyRatePlanOpsRole(login)
      expect(cert.ok).toBe(true)
      expect(cert.probes.map((p) => p.name)).toEqual(expect.arrayContaining(['SELECT tenants id and status', 'SELECT tenants.name', 'UPDATE tenants']))
    } finally { await login.$disconnect() }
  })

  it('expires ended live plans across tenants, and only those', async () => {
    const sweeper = new RatePlanExpirySweeper(ops, { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' })
    sweeper.onModuleInit()
    try {
      expect(await sweeper.runOnce()).toBeGreaterThanOrEqual(4)
      const expected: Record<string, string> = {
        activeWindowEnded: 'EXPIRED', suspendedWindowEnded: 'EXPIRED', activeContractEnded: 'EXPIRED', otherTenantEnded: 'EXPIRED',
        activeInside: 'ACTIVE', activeNoWindow: 'ACTIVE', activeLastDay: 'ACTIVE', draftWindowEnded: 'DRAFT', alreadyExpired: 'EXPIRED', badZone: 'ACTIVE',
      }
      for (const [key, want] of Object.entries(expected)) expect([key, await status(key)]).toEqual([key, want])
    } finally { sweeper.onModuleDestroy() }
  })

  it('writes one SYSTEM audit event per expiry with the reason, in the plan\'s own tenant', async () => {
    const check = async (key: string, tenantId: string, reason: string) => {
      const events = await expiryEvents(key)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ tenantId, actorType: 'SYSTEM', userId: null, entityType: 'rate_plan' })
      expect(events[0].payload).toMatchObject({ before: { status: key === 'suspendedWindowEnded' ? 'SUSPENDED' : 'ACTIVE' }, after: { status: 'EXPIRED' }, reason, source: 'expiry_sweeper' })
    }
    await check('activeWindowEnded', tenantA, 'SALE_WINDOW_ENDED')
    await check('suspendedWindowEnded', tenantA, 'SALE_WINDOW_ENDED')
    await check('activeContractEnded', tenantA, 'CONTRACT_TERM_ENDED')
    await check('otherTenantEnded', tenantB, 'SALE_WINDOW_ENDED')
    for (const key of ['activeInside', 'draftWindowEnded', 'alreadyExpired', 'badZone']) expect(await expiryEvents(key)).toHaveLength(0)
  })

  it('is idempotent: a second pass changes and audits nothing', async () => {
    const before = await prisma.auditEvent.count({ where: { tenantId: { in: [tenantA, tenantB] }, action: 'supply.rate_plan.status_changed' } })
    const sweeper = new RatePlanExpirySweeper(ops, { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' })
    sweeper.onModuleInit()
    try { await sweeper.runOnce() } finally { sweeper.onModuleDestroy() }
    expect(await prisma.auditEvent.count({ where: { tenantId: { in: [tenantA, tenantB] }, action: 'supply.rate_plan.status_changed' } })).toBe(before)
  })

  it('a plan whose window ends tomorrow expires in tomorrow\'s pass, judged in the hotel calendar', async () => {
    const sweeper = new RatePlanExpirySweeper(ops, { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' })
    sweeper.onModuleInit()
    try {
      expect(await status('activeLastDay')).toBe('ACTIVE')
      await sweeper.runOnce(new Date(Date.now() + 2 * DAY)) // two days on: its last day is in the past everywhere
      expect(await status('activeLastDay')).toBe('EXPIRED')
      expect(await status('activeInside')).toBe('ACTIVE')
    } finally { sweeper.onModuleDestroy() }
  })

  it('the new SYSTEM audit policy is as narrow as stated: other SYSTEM events, other tenants and user-attributed SYSTEM rows are refused', async () => {
    const login = new PrismaClient({ datasourceUrl: opsUrl })
    const attempt = (tenant: string, row: { tenantId: string; action: string; entityType: string; userId?: string }) => login.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenant}', true)`)
      await tx.auditEvent.createMany({ data: [{ tenantId: row.tenantId, actorType: 'SYSTEM', action: row.action, entityType: row.entityType, entityId: 'x', payload: {}, ...(row.userId ? { userId: row.userId } : {}) }] })
    })
    try {
      await expect(attempt(tenantA, { tenantId: tenantA, action: 'inventory.hold.expired', entityType: 'inventory_hold' })).rejects.toThrow(/row-level security/)
      await expect(attempt(tenantA, { tenantId: tenantA, action: 'supply.rate_plan.status_changed', entityType: 'booking' })).rejects.toThrow(/row-level security/)
      await expect(attempt(tenantA, { tenantId: tenantB, action: 'supply.rate_plan.status_changed', entityType: 'rate_plan' })).rejects.toThrow(/row-level security/)
      await expect(attempt(tenantA, { tenantId: tenantA, action: 'supply.rate_plan.status_changed', entityType: 'rate_plan' })).resolves.toBeUndefined() // the one permitted shape
    } finally { await login.$disconnect() }
  })

  it('cannot start enabled without the lifecycle credential, and never falls back to the HTTP client', () => {
    const unconfigured = new RatePlanOpsDatabase({ DATABASE_URL: ownerUrl })
    expect(() => new RatePlanExpirySweeper(unconfigured, { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' }).onModuleInit()).toThrow(/RATE_PLAN_OPS_DATABASE_URL/)
    expect(() => new RatePlanExpirySweeper(new RatePlanOpsDatabase({ RATE_PLAN_OPS_DATABASE_URL: ownerUrl, DATABASE_URL: ownerUrl }), { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' }).onModuleInit()).toThrow(/RATE_PLAN_OPS_DATABASE_URL/)
  })
})
