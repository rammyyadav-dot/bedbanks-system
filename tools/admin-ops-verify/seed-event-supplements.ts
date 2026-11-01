// Seeds a tenant with one hotel, an ACTIVE contract and rate plan (SELL basis, for pricing math) and one DRAFT Room Event (ADR 0089
// Phase 2/3: the real "event overlay" feature — a Room Event Master record plus the event/exhibition supplements that reference it),
// a maker and a checker (maker-checker), a read-only viewer, and a second tenant for the cross-tenant checks. For the Admin Room Event
// Master and event-supplement certification. Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const tag = `es-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const DAY = 86_400_000
  const utc = (offset: number) => new Date(base + offset * DAY)

  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const supplierA = (await prisma.supplier.create({ data: { tenantId: A, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} Gulf Direct`, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const supplierB = (await prisma.supplier.create({ data: { tenantId: B, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} Other Supplier`, displayName: 'Other Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const boardA = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const boardB = (await prisma.boardBasis.create({ data: { tenantId: B, code: 'BB', name: 'Bed and breakfast' } })).id

  const hotel = await prisma.hotel.create({ data: { tenantId: A, name: 'Event Overlay Hotel', externalRef: `ES-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5, timeZone: 'Asia/Dubai' } })
  const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe Room', code: 'DLX', maxAdults: 3, maxChildren: 1, maxOccupancy: 4 } })
  const contract = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c1`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  const plan = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract.id, roomTypeId: room.id, boardBasisId: boardA, code: `ES-MAIN-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  const range = Array.from({ length: 60 }, (_, i) => utc(i - 2))
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
  await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, allotment: 10, sold: 0 })) })

  // A second, independent contract/plan to show an event supplement is bound to one contract and never leaks onto another.
  const contract2 = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c2`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  const plan2 = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract2.id, roomTypeId: room.id, boardBasisId: boardA, code: `ES-OTHER-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan2.id, stayDate, occupancy: 2, amountMinor: 40_000n, currency: 'AED', amountBasis: 'SELL' as const })) })

  // Tenant B: one hotel, contract and plan, for the cross-tenant checks.
  const hotelB = await prisma.hotel.create({ data: { tenantId: B, name: 'Other Tenant Hotel', externalRef: `ESB-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4, timeZone: 'Asia/Dubai' } })
  const roomB = await prisma.roomType.create({ data: { hotelId: hotelB.id, name: 'Standard Room', code: 'STD', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
  const contractB = await prisma.contract.create({ data: { tenantId: B, supplierId: supplierB, code: `${tag}-cb`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  const planB = await prisma.ratePlan.create({ data: { tenantId: B, contractId: contractB.id, roomTypeId: roomB.id, boardBasisId: boardB, code: `ES-B-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  void planB

  const perms = ['supply.room_events.read', 'supply.room_events.manage', 'supply.event_supplements.read', 'supply.event_supplements.manage', 'supply.contracts.read', 'supply.rates.read', 'supply.hotels.read']
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return { email, id: u.id }
  }
  const maker = await user('maker', A, perms, 'owner')
  const checker = await user('checker', A, perms, 'owner')
  const viewer = await user('viewer', A, ['supply.room_events.read', 'supply.event_supplements.read', 'supply.hotels.read'])
  const bowner = await user('bowner', B, perms, 'owner')

  const out = { password, makerEmail: maker.email, checkerEmail: checker.email, viewerEmail: viewer.email, bownerEmail: bowner.email, tenantA: A, tenantB: B, hotelId: hotel.id, planId: plan.id, planCode: plan.code, contractId: contract.id, contract2Id: contract2.id, plan2Id: plan2.id, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-event-supplements.json', JSON.stringify(out, null, 2))
  console.log('seeded event-supplements fixtures:', hotel.id)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
