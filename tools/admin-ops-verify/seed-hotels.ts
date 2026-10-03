// Seeds a tenant of 34 hotels (a mix of ready, partial and blocked scenarios) plus a viewer and a second tenant, for the Admin hotel
// commercial browser check. Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/localhost:5432\/fbeds_ci(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be the disposable local fbeds_ci database')

async function main() {
  const prisma = new PrismaService()
  const tag = `hv-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const day = (offset: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + offset * 86_400_000
  const utc = (offset: number) => new Date(day(offset))
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const supplier = async (tenantId: string, name: string) => (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const sA = await supplier(A, 'Gulf Direct'); const sB = await supplier(B, 'Other Supplier')
  const boardA = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const boardB = (await prisma.boardBasis.create({ data: { tenantId: B, code: 'BB', name: 'Bed and breakfast' } })).id
  type O = { city?: string; stars?: number | null; content?: string; mapping?: 'MAPPED' | 'PENDING' | 'NONE'; roomMapped?: boolean; validTo?: number; rates?: boolean; availability?: boolean; stopSell?: number[]; allotment?: number; plan?: boolean; tenant?: 'A' | 'B' }
  const ids: Record<string, string> = {}
  async function hotel(key: string, name: string, o: O = {}) {
    const tenantId = o.tenant === 'B' ? B : A; const supplierId = o.tenant === 'B' ? sB : sA; const boardBasisId = o.tenant === 'B' ? boardB : boardA
    const h = await prisma.hotel.create({ data: { tenantId, name: `${name}`, externalRef: `${key.toUpperCase()}-${tag.slice(-4)}`, propertyType: 'HOTEL', city: o.city ?? 'Dubai', countryCode: 'AE', contentStatus: (o.content ?? 'COMPLETE') as never, starRating: o.stars === undefined ? 5 : o.stars } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe Sea View', code: `D-${key}`.slice(0, 30), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const room2 = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Family Suite', code: `F-${key}`.slice(0, 30), maxAdults: 2, maxChildren: 2, maxOccupancy: 4 } })
    const m = (o.mapping ?? 'MAPPED') === 'NONE' ? null : await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: (o.mapping ?? 'MAPPED') as never } })
    if (m && o.roomMapped !== false) { await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r1`, roomTypeId: room.id, status: 'MAPPED' } }); await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r2`, roomTypeId: room2.id, status: 'MAPPED' } }) }
    const c = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: m?.id ?? null, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(o.validTo ?? 4000), settlementCurrency: 'AED' } })
    if (o.plan !== false) {
      for (const [r, label, occ] of [[room, 'DLX', 2], [room2, 'FAM', 2]] as const) {
        const p = await prisma.ratePlan.create({ data: { tenantId, contractId: c.id, roomTypeId: r.id, boardBasisId, code: `${key}-${label}`.slice(0, 30), status: 'ACTIVE', occupancy: occ, currency: 'AED' } })
        const range = Array.from({ length: 46 }, (_, i) => utc(-3 + i)) // covers the default 30-night window and beyond
        if (o.rates !== false) await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: p.id, stayDate, occupancy: occ, amountMinor: label === 'DLX' ? 49_900n : 79_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
        if (o.availability !== false) await prisma.dailyAvailability.createMany({ data: range.map((stayDate, i) => ({ tenantId, ratePlanId: p.id, stayDate, allotment: o.allotment ?? 6, stopSell: label === 'DLX' && (o.stopSell ?? []).includes(-3 + i) })) })
      }
    }
    ids[key] = h.id
  }
  await hotel('alpha', 'Atlantis Palm Resort'); await hotel('bravo', 'Burj View Hotel', { stopSell: [15] }); await hotel('charlie', 'Creek Harbour Inn', { mapping: 'PENDING', roomMapped: false })
  await hotel('delta', 'Deira Gate Hotel', { roomMapped: false }); await hotel('echo', 'Emirates Old Town', { validTo: -5 }); await hotel('foxtrot', 'Festival City Suites', { rates: false })
  await hotel('golf', 'Gold Souk Residence', { availability: false }); await hotel('hotel', 'Hatta Mountain Lodge', { stopSell: Array.from({ length: 46 }, (_, i) => -3 + i) })
  await hotel('india', 'Marina Bay Towers', { allotment: 0 }); await hotel('juliet', 'Jumeirah Beach Club', { validTo: 21 }); await hotel('kilo', 'Karama Budget Stay', { plan: false, mapping: 'NONE', stars: null, content: 'DRAFT' })
  await hotel('mike', 'Corniche Abu Dhabi Hotel', { city: 'Abu Dhabi' })
  for (let i = 0; i < 22; i++) await hotel(`f${String(i).padStart(2, '0')}`, `Filler Dubai Hotel ${String(i + 1).padStart(2, '0')}`)
  await hotel('oscar', 'Other Tenant Hotel', { tenant: 'B' })
  const perms = ['supply.hotels.read', 'supply.contracts.read', 'supply.mappings.read', 'supply.mappings.manage', 'supply.rates.read', 'supply.suppliers.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage', 'audit.read', 'booking.read']
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return email
  }
  const owner = await user('owner', A, perms, 'owner'); const viewer = await user('viewer', A, ['supply.hotels.read']); const bowner = await user('bowner', B, perms, 'owner')
  await prisma.booking.create({ data: { tenantId: A, reference: `${tag}-BK1`, supplier: 'contracted', hotelId: ids.alpha, status: 'CONFIRMED', currency: 'AED', totalMinor: 149_700n, idempotencyKey: `${tag}-bk`, searchSnapshot: { checkIn: new Date(day(10)).toISOString().slice(0, 10), checkOut: new Date(day(13)).toISOString().slice(0, 10) } } })
  await prisma.auditEvent.create({ data: { tenantId: A, userId: null, actorType: 'SYSTEM', action: 'supply.hotel.updated', entityType: 'hotel', entityId: ids.alpha, payload: { requestId: 'req-verify-1', note: 'seeded' } } })
  const out = { password, ownerEmail: owner, viewerEmail: viewer, bownerEmail: bowner, hotels: ids, tenantA: A, tenantB: B, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-hotels.json', JSON.stringify(out, null, 2))
  console.log('seeded', Object.keys(ids).length, 'hotels')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
