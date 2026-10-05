// Seeds the pool capacity editor and per-plan consumption browser check (ADR 0036): one Dubai hotel whose three rate plans share a pool of 10, with
// real holds in several lifecycle states, a night at its committed floor, an empty second pool, and four Admin users (full operator, previewer,
// read-only viewer, other tenant). DISPOSABLE local database only. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'
import { InventoryHoldService } from '../../apps/api/src/agent/inventory-hold.service'
import { moveNight } from '../../apps/api/src/inventory/inventory-counters'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const holds = new InventoryHoldService(prisma)
  const tag = `pcv-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  const day = (o: number) => utc(o).toISOString().slice(0, 10)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const supplierId = (await prisma.supplier.create({ data: { tenantId: A, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} S`, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const supplierB = (await prisma.supplier.create({ data: { tenantId: B, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} SB`, displayName: 'Other Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const boardA = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const boardB = (await prisma.boardBasis.create({ data: { tenantId: B, code: 'BB', name: 'Bed and breakfast' } })).id
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return { email, id: u.id }
  }
  const view = ['supply.hotels.read', 'supply.contracts.read', 'supply.mappings.read', 'supply.rooms.read', 'supply.rates.read', 'supply.availability.read']
  const operator = await user('operator', A, [...view, 'supply.availability.manage', 'supply.pool_capacity.preview', 'supply.pool_capacity.apply', 'supply.pool_nights.request', 'audit.read'], 'owner')
  const checker = await user('checker', A, [...view, 'supply.pool_nights.decide'])
  const previewer = await user('previewer', A, [...view, 'supply.pool_capacity.preview'])
  const viewer = await user('viewer', A, view)
  const bowner = await user('bowner', B, [...view, 'supply.pool_capacity.preview', 'supply.pool_capacity.apply'], 'owner')

  async function hotel(tenantId: string, supplier: string, board: string, key: string, name: string, poolName: string, planCodes: string[], poolDays: boolean) {
    const h = await prisma.hotel.create({ data: { tenantId, name, externalRef: `${key.toUpperCase()}-${tag.slice(-4)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Verification Road', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe', code: `D-${key}`, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId: supplier, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await prisma.contract.create({ data: { tenantId, supplierId: supplier, supplierHotelMappingId: m.id, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(400), settlementCurrency: 'AED' } })
    const creator = tenantId === A ? operator.id : bowner.id
    const pool = await prisma.inventoryPool.create({ data: { tenantId, hotelId: h.id, supplierId: supplier, name: poolName, createdById: creator } })
    const range = Array.from({ length: 60 }, (_, i) => utc(i))
    if (poolDays) await prisma.inventoryPoolDay.createMany({ data: range.map((stayDate) => ({ tenantId, poolId: pool.id, stayDate, capacity: 10 })) })
    const planIds: string[] = []
    for (const code of planCodes) {
      const p = await prisma.ratePlan.create({ data: { tenantId, contractId: c.id, roomTypeId: room.id, boardBasisId: board, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, inventoryPoolId: pool.id } })
      planIds.push(p.id)
      await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: [...range, utc(60)].map((stayDate) => ({ tenantId, ratePlanId: p.id, stayDate, allotment: 10 })) })
    }
    return { hotelId: h.id, roomId: room.id, poolId: pool.id, planIds, boardId: board }
  }
  const palm = await hotel(A, supplierId, boardA, 'palm', 'Palm Pool Resort', 'Palm shared', ['P1', 'P2', 'P3'], true)
  const empty = await hotel(A, supplierId, boardA, 'dune', 'Dune Empty Pool Hotel', 'Dune shared', ['D1'], false)
  const other = await hotel(B, supplierB, boardB, 'oscar', 'Other Tenant Hotel', 'Beta pool', ['O1'], true)

  // Real holds through the production services. Night N (d+3): P1 held 2, P1 sold 2, P2 held 1, P2 released, P3 sold then cancelled.
  const hold = (key: string, planId: string, from: number, rooms = 1) => holds.create({
    tenantId: A, userId: operator.id, requestId: `${key}-r`, idempotencyKey: `${tag}-${key}`, offerId: 'o', searchId: 's', ratePlanId: planId, canonicalHotelId: palm.hotelId, canonicalRoomTypeId: palm.roomId,
    boardBasisId: palm.boardId, checkIn: day(from), checkOut: day(from + 1), rooms, currency: 'AED', sellAmountMinor: 49_900, offerExpiresAt: utc(40).toISOString(),
  })
  const nightsOf = (holdId: string) => prisma.inventoryHoldNight.findMany({ where: { holdId }, select: { availabilityId: true, counterKind: true, poolDayId: true, quantity: true } })
  const confirm = async (holdId: string) => { const n = await nightsOf(holdId); await prisma.$transaction(async (tx) => { for (const x of n) await moveNight(tx as never, A, x, 'confirm') }); await prisma.inventoryHold.update({ where: { id: holdId }, data: { status: 'CONFIRMED' } }) }
  const cancel = async (holdId: string) => { const n = await nightsOf(holdId); await prisma.$transaction(async (tx) => { for (const x of n) await moveNight(tx as never, A, x, 'cancel') }); await prisma.inventoryHold.update({ where: { id: holdId }, data: { status: 'RELEASED', releasedAt: new Date() } }) }
  const [p1, p2, p3] = palm.planIds
  await hold('a-held', p1, 3, 2)
  await confirm((await hold('a-sold', p1, 3, 2)).holdId)
  await hold('b-held', p2, 3)
  await holds.release(A, (await hold('b-rel', p2, 3)).holdId, `${tag}-rel`, { type: 'USER', userId: operator.id })
  const c1 = await hold('c-sold', p3, 3); await confirm(c1.holdId); await cancel(c1.holdId)
  // Night d+5 sits at its committed floor: capacity 3 = sold 1 + held 2.
  await hold('floor-held', p1, 5, 2); await confirm((await hold('floor-sold', p2, 5)).holdId)
  await prisma.inventoryPoolDay.updateMany({ where: { poolId: palm.poolId, stayDate: utc(5) }, data: { capacity: 3 } })

  const out = { password, operatorEmail: operator.email, checkerEmail: checker.email, previewerEmail: previewer.email, viewerEmail: viewer.email, bownerEmail: bowner.email, palm, empty, other, dates: { consumption: day(3), floor: day(5), free: day(8), from: day(0) }, tenantA: A, tenantB: B, tag, names: { palm: 'Palm Pool Resort', empty: 'Dune Empty Pool Hotel' } }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-pool-capacity.json', JSON.stringify(out, null, 2))
  console.log('seeded pool of 10 over 3 plans with holds in five lifecycle states')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
