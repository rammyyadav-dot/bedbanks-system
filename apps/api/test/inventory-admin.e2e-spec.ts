import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { InventoryAdminService } from '../src/inventory/inventory-admin.service'
import { HotelQuickUpdateService } from '../src/hotel-setup/hotel-quick-update.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'

/** Pool management, release rule and Quick Update inventory edits on real PostgreSQL: atomic, idempotent, stale-rejecting, audited, tenant-isolated. */
describe('inventory admin (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const inventory = new InventoryAdminService(prisma)
  const quick = new HotelQuickUpdateService(prisma)
  const holds = new InventoryHoldService(prisma)
  const suffix = `ia-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const D = [day(30), day(31), day(32)]
  let tenantA: string, tenantB: string, userA: string, userRO: string, supplierA: string, supplierA2: string, supplierB: string, hotelA: string, hotelB: string
  const planIds: string[] = []; let planOtherSupplier: string, planOtherHotel: string, planB: string
  let roomA: string, boardA: string, contractA2: string

  async function permissions(tenantId: string, userId: string, keys: string[]) {
    const role = await prisma.role.create({ data: { tenantId, name: `r-${userId.slice(-6)}-${Math.random().toString(36).slice(2, 6)}` } })
    for (const key of keys) {
      const perm = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } })
    }
    await prisma.userRole.create({ data: { tenantId, userId, roleId: role.id } })
  }
  async function world(tenantId: string, tag: string) {
    const supplier = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix}${tag} s`, displayName: `S${tag}`, countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const hotel = (await prisma.hotel.create({ data: { tenantId, name: `${suffix}${tag} hotel`, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE' } })).id
    const room = (await prisma.roomType.create({ data: { hotelId: hotel, name: 'Room', code: `${suffix}${tag}`, maxAdults: 2, maxOccupancy: 2 } })).id
    const board = (await prisma.boardBasis.create({ data: { tenantId, code: `R${tag}`, name: `ROH ${suffix}${tag}` } })).id
    const hm = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId: supplier, hotelId: hotel, supplierHotelId: `${suffix}${tag}-sh`, status: 'MAPPED' } })).id
    const contract = (await prisma.contract.create({ data: { tenantId, supplierId: supplier, supplierHotelMappingId: hm, code: `${suffix}${tag}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    return { supplier, hotel, room, board, contract }
  }
  const plan = async (tenantId: string, w: { contract: string; room: string; board: string }, code: string) => (await prisma.ratePlan.create({ data: { tenantId, contractId: w.contract, roomTypeId: w.room, boardBasisId: w.board, code: `${suffix}-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
  const auditCount = (tenantId: string, action: string) => prisma.auditEvent.count({ where: { tenantId, action } })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    userA = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    userRO = (await prisma.user.create({ data: { email: `${suffix}-ro@example.test` } })).id
    for (const [t, u] of [[tenantA, userA], [tenantA, userRO]] as const) await prisma.membership.create({ data: { tenantId: t, userId: u, role: 'owner' } })
    await permissions(tenantA, userA, ['supply.availability.manage', 'supply.availability.read', 'supply.rates.read', 'supply.rates.manage'])
    await permissions(tenantA, userRO, ['supply.availability.read', 'supply.rates.read'])
    const a = await world(tenantA, 'a'); supplierA = a.supplier; hotelA = a.hotel; roomA = a.room; boardA = a.board
    const a2 = await world(tenantA, 'a2'); supplierA2 = a2.supplier
    const b = await world(tenantB, 'b'); supplierB = b.supplier; hotelB = b.hotel
    for (const code of ['p1', 'p2', 'p3']) planIds.push(await plan(tenantA, a, code))
    // another supplier on the same hotel, a plan of another hotel, and a plan of another tenant
    const hm2 = (await prisma.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId: supplierA2, hotelId: hotelA, supplierHotelId: `${suffix}-sh2`, status: 'MAPPED' } })).id
    contractA2 = (await prisma.contract.create({ data: { tenantId: tenantA, supplierId: supplierA2, supplierHotelMappingId: hm2, code: `${suffix}-c2`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    planOtherSupplier = await plan(tenantA, { contract: contractA2, room: roomA, board: boardA }, 'other-supplier')
    planOtherHotel = await plan(tenantA, a2, 'other-hotel')
    planB = await plan(tenantB, b, 'tenant-b')
    for (const id of [...planIds, planOtherSupplier]) await prisma.dailyAvailability.createMany({ data: D.map((d) => ({ tenantId: tenantA, ratePlanId: id, stayDate: new Date(d), allotment: 3 })) })
  })

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.auditEvent.deleteMany({ where: { tenantId: t } }); await prisma.inventoryHoldNight.deleteMany({ where: { tenantId: t } }); await prisma.inventoryHold.deleteMany({ where: { tenantId: t } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId: t } }); await prisma.dailyRate.deleteMany({ where: { tenantId: t } }); await prisma.ratePlan.deleteMany({ where: { tenantId: t } })
      await prisma.inventoryPoolDay.deleteMany({ where: { tenantId: t } }); await prisma.inventoryPool.deleteMany({ where: { tenantId: t } })
      await prisma.contract.deleteMany({ where: { tenantId: t } }); await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: t } }); await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: t } })
      await prisma.boardBasis.deleteMany({ where: { tenantId: t } }); await prisma.roomType.deleteMany({ where: { hotel: { tenantId: t } } }); await prisma.hotel.deleteMany({ where: { tenantId: t } }); await prisma.supplier.deleteMany({ where: { tenantId: t } })
      await prisma.userRole.deleteMany({ where: { tenantId: t } }); await prisma.role.deleteMany({ where: { tenantId: t } }); await prisma.membership.deleteMany({ where: { tenantId: t } })
    }
    await prisma.user.deleteMany({ where: { id: { in: [userA, userRO] } } }); await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  let poolId: string; let poolToken: string
  const key = (n: string) => `${suffix}-${n}`.slice(0, 80)

  it('INV-01 creates a pool with members, audits it, and an identical retry replays without a second pool', async () => {
    const body = { name: 'Shared 5', supplierId: supplierA, ratePlanIds: [planIds[0], planIds[1]], idempotencyKey: key('create') }
    const first = await inventory.createPool(tenantA, userA, hotelA, body, 'req-1')
    expect(first.replayed).toBe(false); expect(first.pool!.members.map((m) => m.ratePlanId).sort()).toEqual([planIds[0], planIds[1]].sort())
    poolId = first.pool!.id; poolToken = first.pool!.updatedAt
    const again = await inventory.createPool(tenantA, userA, hotelA, body, 'req-2')
    expect(again.replayed).toBe(true); expect(again.pool!.id).toBe(poolId)
    expect(await prisma.inventoryPool.count({ where: { tenantId: tenantA, hotelId: hotelA } })).toBe(1)
    expect(await auditCount(tenantA, 'inventory.pool.created')).toBe(1); expect(await auditCount(tenantA, 'inventory.pool.member_added')).toBe(2)
    await expect(inventory.createPool(tenantA, userA, hotelA, { ...body, name: 'Different' }, 'req-3')).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } })
  })

  it('INV-02 refuses duplicate names, a plan already pooled, another supplier, another hotel, another tenant, and an unmapped supplier', async () => {
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'Shared 5', supplierId: supplierA, idempotencyKey: key('dup') }, null)).rejects.toMatchObject({ response: { code: 'POOL_NAME_TAKEN' } })
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X1', supplierId: supplierA, ratePlanIds: [planIds[0]], idempotencyKey: key('already') }, null)).rejects.toMatchObject({ response: { code: 'POOL_MEMBER_IN_OTHER_POOL' } })
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X2', supplierId: supplierA, ratePlanIds: [planOtherSupplier], idempotencyKey: key('sup') }, null)).rejects.toMatchObject({ response: { code: 'POOL_SUPPLIER_MISMATCH' } })
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X3', supplierId: supplierA, ratePlanIds: [planOtherHotel], idempotencyKey: key('hotel') }, null)).rejects.toMatchObject({ response: { code: 'POOL_MEMBER_NOT_FOUND' } })
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X4', supplierId: supplierA, ratePlanIds: [planB], idempotencyKey: key('tenant') }, null)).rejects.toMatchObject({ response: { code: 'POOL_MEMBER_NOT_FOUND' } })
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X5', supplierId: supplierB, idempotencyKey: key('supB') }, null)).rejects.toMatchObject({ response: { code: 'POOL_SUPPLIER_NOT_MAPPED' } })
    await expect(inventory.createPool(tenantA, userA, hotelB, { name: 'X6', supplierId: supplierA, idempotencyKey: key('hotelB') }, null)).rejects.toBeInstanceOf(NotFoundException)
    await expect(inventory.createPool(tenantA, userA, hotelA, { name: 'X7', supplierId: supplierA, ratePlanIds: [planIds[2], planIds[2]], idempotencyKey: key('twice') }, null)).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(await prisma.inventoryPool.count({ where: { tenantId: tenantA } })).toBe(1)
  })

  it('INV-03 membership changes reject a stale token and replay idempotently; a plan with units sold cannot join', async () => {
    await expect(inventory.addMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: [planIds[2]], expectedUpdatedAt: new Date(0).toISOString(), idempotencyKey: key('stale') }, null)).rejects.toMatchObject({ response: { code: 'POOL_STALE' } })
    expect(await prisma.ratePlan.findUniqueOrThrow({ where: { id: planIds[2] } })).toMatchObject({ inventoryPoolId: null })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: planIds[2], stayDate: new Date(D[0]) }, data: { sold: 1 } })
    await expect(inventory.addMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: [planIds[2]], expectedUpdatedAt: poolToken, idempotencyKey: key('commit') }, null)).rejects.toMatchObject({ response: { code: 'POOL_MEMBER_HAS_COMMITMENTS' } })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: planIds[2] }, data: { sold: 0 } })
    const added = await inventory.addMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: [planIds[2]], expectedUpdatedAt: poolToken, idempotencyKey: key('add') }, 'r')
    expect(added.pool!.members).toHaveLength(3); expect(added.pool!.updatedAt).not.toBe(poolToken)
    const replay = await inventory.addMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: [planIds[2]], expectedUpdatedAt: poolToken, idempotencyKey: key('add') }, 'r')
    expect(replay.replayed).toBe(true)
    poolToken = added.pool!.updatedAt
    expect(await auditCount(tenantA, 'inventory.pool.member_added')).toBe(3)
  })

  it('INV-04 Quick Update sets the pool capacity once for three plans and the summary shows 5, not 15', async () => {
    const scope = { ratePlanIds: planIds, ranges: [{ from: D[0], to: D[2] }] }
    const changes = { availability: { allotment: 5 } }
    const preview = await quick.preview(tenantA, userA, hotelA, { scope, changes })
    expect(preview.errors).toEqual([]); expect(preview.canApply).toBe(true)
    expect(preview.rows.filter((r) => r.changes.some((c) => c.field === 'poolCapacity'))).toHaveLength(9) // 3 plans x 3 nights, each reporting the pool change
    const applied = await quick.apply(tenantA, userA, hotelA, { scope, changes, idempotencyKey: key('qu1'), expectedFingerprint: preview.fingerprint, reason: 'set shared pool' }, 'req-q')
    expect(applied.changed.poolDays).toBe(3) // one per pool night, not nine
    const days = await prisma.inventoryPoolDay.findMany({ where: { poolId } })
    expect(days.map((d) => d.capacity)).toEqual([5, 5, 5]); expect(days.every((d) => d.source === 'ADMIN' && d.freshUntil === null && d.sourceUpdatedAt !== null)).toBe(true)
    const summary = await inventory.summary(tenantA, hotelA, { from: D[0], days: 3 })
    const pool = summary.pools.find((p) => p.id === poolId)!
    expect(pool.nights.map((n) => n.capacity)).toEqual([5, 5, 5]); expect(pool.nights.map((n) => n.remaining)).toEqual([5, 5, 5]); expect(pool.missingNights).toBe(0)
    expect(summary.totals).toMatchObject({ pooledPlans: 3, pools: 1 })
    expect(await auditCount(tenantA, 'inventory.bulk.updated')).toBe(1)
  })

  it('INV-05 a hold after the preview makes apply stale and writes nothing; a capacity below held is refused', async () => {
    const scope = { ratePlanIds: [planIds[0]], ranges: [{ from: D[0], to: D[0] }] }
    const changes = { availability: { allotment: 7 } }
    const preview = await quick.preview(tenantA, userA, hotelA, { scope, changes })
    const hold = await holds.create({ tenantId: tenantA, userId: userA, requestId: 'h', idempotencyKey: key('hold'), offerId: 'o', searchId: 's', ratePlanId: planIds[1], canonicalHotelId: hotelA, canonicalRoomTypeId: roomA, boardBasisId: boardA, checkIn: D[0], checkOut: D[1], rooms: 2, currency: 'AED', sellAmountMinor: 1000, offerExpiresAt: '2099-01-01T12:00:00.000Z' })
    await expect(quick.apply(tenantA, userA, hotelA, { scope, changes, idempotencyKey: key('qu-stale'), expectedFingerprint: preview.fingerprint, reason: 'stale try' }, null)).rejects.toMatchObject({ response: { code: 'QUICK_UPDATE_STALE' } })
    expect((await prisma.inventoryPoolDay.findFirstOrThrow({ where: { poolId, stayDate: new Date(D[0]) } })).capacity).toBe(5)
    const low = await quick.preview(tenantA, userA, hotelA, { scope, changes: { availability: { allotment: 1 } } })
    expect(low.canApply).toBe(false); expect(low.rows[0].problems.join(' ')).toMatch(/below the 2 already sold or held on the pool/)
    await holds.release(tenantA, hold.holdId, 'r', { type: 'USER', userId: userA })
  })

  it('INV-06 Quick Update sets mode and closed-to-departure, stamps provenance, and audits the mode change', async () => {
    const scope = { ratePlanIds: [planIds[0]], ranges: [{ from: D[1], to: D[1] }] }
    const changes = { availability: { mode: 'ON_REQUEST' as const }, restrictions: { closedToDeparture: 'SET' as const } }
    const preview = await quick.preview(tenantA, userA, hotelA, { scope, changes })
    expect(preview.rows[0].changes.map((c) => c.field).sort()).toEqual(['closedToDeparture', 'inventoryMode'])
    await quick.apply(tenantA, userA, hotelA, { scope, changes, idempotencyKey: key('qu-mode'), expectedFingerprint: preview.fingerprint, reason: 'on request for event' }, null)
    const row = await prisma.dailyAvailability.findFirstOrThrow({ where: { ratePlanId: planIds[0], stayDate: new Date(D[1]) } })
    expect(row).toMatchObject({ inventoryMode: 'ON_REQUEST', closedToDeparture: true, source: 'ADMIN', freshUntil: null }); expect(row.sourceUpdatedAt).not.toBeNull()
    expect(await auditCount(tenantA, 'inventory.mode.changed')).toBe(1); expect(await auditCount(tenantA, 'inventory.daily.updated')).toBe(1)
    const replay = await quick.apply(tenantA, userA, hotelA, { scope, changes, idempotencyKey: key('qu-mode'), expectedFingerprint: preview.fingerprint, reason: 'on request for event' }, null)
    expect(replay.replayed).toBe(true); expect(await auditCount(tenantA, 'inventory.mode.changed')).toBe(1)
  })

  it('INV-07 a read-only account can preview nothing that writes: apply is forbidden without the manage permission', async () => {
    const scope = { ratePlanIds: [planIds[0]], ranges: [{ from: D[2], to: D[2] }] }
    const changes = { availability: { stopSell: 'SET' as const } }
    const preview = await quick.preview(tenantA, userA, hotelA, { scope, changes })
    await expect(quick.apply(tenantA, userRO, hotelA, { scope, changes, idempotencyKey: key('ro'), expectedFingerprint: preview.fingerprint, reason: 'no rights' }, null)).rejects.toBeInstanceOf(ForbiddenException)
    expect((await prisma.dailyAvailability.findFirstOrThrow({ where: { ratePlanId: planIds[0], stayDate: new Date(D[2]) } })).stopSell).toBe(false)
  })

  it('INV-08 the release rule is changed with compare-and-set, validated, idempotent and audited', async () => {
    const summary = await inventory.summary(tenantA, hotelA, {})
    const token = summary.plans.find((p) => p.ratePlanId === planIds[0])!.updatedAt
    await expect(inventory.setRelease(tenantA, userA, hotelA, planIds[0], { releaseDays: 7, releaseTimeLocal: '24:00', expectedUpdatedAt: token, reason: 'bad time', idempotencyKey: key('rel-bad') }, null)).rejects.toThrow(/HH:mm/)
    await expect(inventory.setRelease(tenantA, userA, hotelA, planIds[0], { releaseDays: 7, releaseTimeLocal: '18:00', expectedUpdatedAt: new Date(0).toISOString(), reason: 'stale form', idempotencyKey: key('rel-stale') }, null)).rejects.toMatchObject({ response: { code: 'PLAN_STALE' } })
    const done = await inventory.setRelease(tenantA, userA, hotelA, planIds[0], { releaseDays: 7, releaseTimeLocal: '18:00', expectedUpdatedAt: token, reason: 'supplier cut-off', idempotencyKey: key('rel') }, 'r')
    expect(done).toMatchObject({ replayed: false, releaseDays: 7, releaseTimeLocal: '18:00' })
    expect(await prisma.ratePlan.findUniqueOrThrow({ where: { id: planIds[0] } })).toMatchObject({ releaseDays: 7, releaseTimeLocal: '18:00' })
    expect((await inventory.setRelease(tenantA, userA, hotelA, planIds[0], { releaseDays: 7, releaseTimeLocal: '18:00', expectedUpdatedAt: token, reason: 'supplier cut-off', idempotencyKey: key('rel') }, 'r')).replayed).toBe(true)
    const audit = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: 'inventory.release.changed' } })
    expect(audit).toHaveLength(1); expect(audit[0].payload).toMatchObject({ from: { releaseDays: 0, releaseTimeLocal: '00:00' }, to: { releaseDays: 7, releaseTimeLocal: '18:00' }, reason: 'supplier cut-off' })
    await expect(inventory.setRelease(tenantA, userA, hotelB, planIds[0], { releaseDays: 1, releaseTimeLocal: '00:00', expectedUpdatedAt: token, reason: 'wrong hotel', idempotencyKey: key('rel-x') }, null)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('INV-09 removing members and archiving obey the rules; every change is audited and another tenant sees nothing', async () => {
    const s = await inventory.summary(tenantA, hotelA, {}); let token = s.pools.find((p) => p.id === poolId)!.updatedAt
    await expect(inventory.updatePool(tenantA, userA, hotelA, poolId, { archive: true, expectedUpdatedAt: token, idempotencyKey: key('arch1') }, null)).rejects.toMatchObject({ response: { code: 'POOL_HAS_MEMBERS' } })
    const removed = await inventory.removeMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: planIds, expectedUpdatedAt: token, idempotencyKey: key('rm') }, null)
    expect(removed.pool!.members).toHaveLength(0); token = removed.pool!.updatedAt
    const renamed = await inventory.updatePool(tenantA, userA, hotelA, poolId, { name: 'Renamed', expectedUpdatedAt: token, idempotencyKey: key('ren') }, null)
    expect(renamed.pool!.name).toBe('Renamed'); token = renamed.pool!.updatedAt
    const archived = await inventory.updatePool(tenantA, userA, hotelA, poolId, { archive: true, expectedUpdatedAt: token, idempotencyKey: key('arch2') }, null)
    expect(archived.pool!.status).toBe('ARCHIVED')
    await expect(inventory.addMembers(tenantA, userA, hotelA, poolId, { ratePlanIds: [planIds[0]], expectedUpdatedAt: archived.pool!.updatedAt, idempotencyKey: key('add-arch') }, null)).rejects.toMatchObject({ response: { code: 'POOL_ARCHIVED' } })
    expect(await auditCount(tenantA, 'inventory.pool.member_removed')).toBe(1); expect(await auditCount(tenantA, 'inventory.pool.updated')).toBe(2)
    await expect(inventory.summary(tenantB, hotelA, {})).rejects.toBeInstanceOf(NotFoundException)
    await expect(inventory.updatePool(tenantB, userA, hotelA, poolId, { name: 'Hijack', expectedUpdatedAt: archived.pool!.updatedAt, idempotencyKey: key('x-tenant') }, null)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('INV-10 concurrent identical creates produce one pool; a missing pool day shows as unknown, never zero', async () => {
    const body = { name: 'Race', supplierId: supplierA, ratePlanIds: [], idempotencyKey: key('race') }
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => inventory.createPool(tenantA, userA, hotelA, body, null)))
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    expect(await prisma.inventoryPool.count({ where: { tenantId: tenantA, name: 'Race' } })).toBe(1)
    const summary = await inventory.summary(tenantA, hotelA, { from: D[0], days: 3 })
    const race = summary.pools.find((p) => p.name === 'Race')!
    expect(race.nights.map((n) => n.capacity)).toEqual([null, null, null]); expect(race.missingNights).toBe(3)
    expect(ConflictException).toBeDefined()
  })
})
