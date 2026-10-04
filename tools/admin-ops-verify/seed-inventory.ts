// Seeds the Inventory & Allotment browser check: one Dubai hotel whose three rate plans share a pool of 5, a second hotel with no pool
// (empty state), an Admin owner, a read-only Admin viewer, an Agent and a second tenant. DISPOSABLE local database only. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/localhost:5432\/fbeds_ci(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be the disposable local fbeds_ci database')

async function main() {
  const prisma = new PrismaService()
  const tag = `iv-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const supplierId = (await prisma.supplier.create({ data: { tenantId: A, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} S`, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
  const boardBasisId = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const ids: Record<string, string> = {}; const planIds: string[] = []
  async function hotel(key: string, name: string, plans: string[], pooled: boolean) {
    const h = await prisma.hotel.create({ data: { tenantId: A, name, externalRef: `${key.toUpperCase()}-${tag.slice(-4)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Verification Road', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe', code: `D-${key}`, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId: A, supplierId, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: A, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await prisma.contract.create({ data: { tenantId: A, supplierId, supplierHotelMappingId: m.id, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(400), settlementCurrency: 'AED' } as never })
    const owner = await prisma.user.findFirst({ where: { email: `owner-${tag}@verify.test` } })
    const pool = pooled && owner ? await prisma.inventoryPool.create({ data: { tenantId: A, hotelId: h.id, supplierId, name: 'Palm shared', createdById: owner.id } }) : null
    const range = Array.from({ length: 60 }, (_, i) => utc(i))
    if (pool) await prisma.inventoryPoolDay.createMany({ data: range.map((stayDate) => ({ tenantId: A, poolId: pool.id, stayDate, capacity: 5 })) })
    for (const code of plans) {
      const p = await prisma.ratePlan.create({ data: { tenantId: A, contractId: c.id, roomTypeId: room.id, boardBasisId, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, inventoryPoolId: pool?.id ?? null } })
      if (pooled) planIds.push(p.id)
      await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, allotment: pooled ? 9 : 4 })) })
    }
    ids[key] = h.id
  }
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return email
  }
  const adminPerms = ['supply.hotels.read', 'supply.hotels.manage', 'supply.contracts.read', 'supply.mappings.read', 'supply.rooms.read', 'supply.rates.read', 'supply.rates.manage', 'supply.availability.read', 'supply.availability.manage', 'supply.suppliers.read', 'audit.read', 'booking.read']
  const owner = await user('owner', A, adminPerms, 'owner')
  const viewer = await user('viewer', A, ['supply.hotels.read', 'supply.rates.read', 'supply.availability.read', 'supply.rooms.read', 'supply.contracts.read', 'supply.mappings.read'])
  const bowner = await user('bowner', B, adminPerms, 'owner')
  const agent = await user('agent', A, ['hotel.search', 'booking.read'])
  await hotel('palm', 'Palm Pool Resort', ['P1', 'P2', 'P3'], true)
  await hotel('solo', 'Solo Plan Hotel', ['S1'], false)
  const out = { password, ownerEmail: owner, viewerEmail: viewer, bownerEmail: bowner, agentEmail: agent, hotels: ids, planIds, names: { palm: 'Palm Pool Resort', solo: 'Solo Plan Hotel' }, tenantA: A, tenantB: B, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-inventory.json', JSON.stringify(out, null, 2))
  console.log('seeded 2 hotels, pool of 5 over 3 plans')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
