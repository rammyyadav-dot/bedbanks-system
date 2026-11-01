// Seeds a tenant with one hotel (a room type with a valid occupancy triple and an ACTIVE contract/rate plan for pricing), a second
// contract still in DRAFT for the Admin UI's child-age-band (extra-bed) create/validate flow, and a second tenant, for the Admin Rooms
// panel and contract child-policy certification: room occupancy rules (ADR 0021 stage 2) and extra-bed/child-supplement pricing
// (ADR 0057 S6 / ADR 0067 F-03). Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const tag = `ro-${Date.now()}`
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

  const hotel = await prisma.hotel.create({ data: { tenantId: A, name: 'Room Occupancy Hotel', externalRef: `RO-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5, timeZone: 'Asia/Dubai' } })
  // 2 adults + 1 child = 3, exactly the room's maximum: a valid occupancy triple (occupancyProblems requires maxOccupancy >= maxAdults + maxChildren).
  const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Family Room', code: 'FAM', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, beddingMetadata: {} } })

  const contract1 = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c1`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  // The contract's child band: ages 2-12 may take an extra bed, charged a per-night supplement. No GuestPriceLine of its own on the plan,
  // so this band is what effectiveGuestLines falls back to (ADR 0067 F-03): one child policy governs a plan with no lines of its own.
  await prisma.childPolicy.create({ data: { contractId: contract1.id, minAge: 2, maxAge: 12, extraBedAllowed: true, supplementMinor: 5_000n, currency: 'AED' } })
  const plan = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract1.id, roomTypeId: room.id, boardBasisId: boardA, code: `RO-MAIN-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  const range = Array.from({ length: 30 }, (_, i) => utc(i - 2))
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
  await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, allotment: 10, sold: 0 })) })

  // Contract 2: DRAFT (termsEditable) for the UI's add/validate child-band flow; no rate plan needed.
  const contract2 = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c2`, status: 'DRAFT', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })

  // Tenant B: one hotel, contract and room, for the cross-tenant checks.
  const hotelB = await prisma.hotel.create({ data: { tenantId: B, name: 'Other Tenant Hotel', externalRef: `ROB-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4, timeZone: 'Asia/Dubai' } })
  const roomB = await prisma.roomType.create({ data: { hotelId: hotelB.id, name: 'Standard Room', code: 'STD', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
  const contractB = await prisma.contract.create({ data: { tenantId: B, supplierId: supplierB, code: `${tag}-cb`, status: 'DRAFT', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  void roomB; void boardB

  const perms = ['supply.rooms.read', 'supply.rooms.manage', 'supply.contracts.read', 'supply.contracts.manage', 'supply.rates.read', 'supply.hotels.read']
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return { email }
  }
  const owner = await user('owner', A, perms, 'owner')
  const viewer = await user('viewer', A, ['supply.rooms.read', 'supply.hotels.read'])
  const bowner = await user('bowner', B, perms, 'owner')

  const out = { password, ownerEmail: owner.email, viewerEmail: viewer.email, bownerEmail: bowner.email, tenantA: A, tenantB: B, hotelId: hotel.id, roomId: room.id, roomCode: room.code, planId: plan.id, planCode: plan.code, contract1Id: contract1.id, contract2Id: contract2.id, contractBId: contractB.id, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-room-occupancy.json', JSON.stringify(out, null, 2))
  console.log('seeded room-occupancy fixtures:', hotel.id)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
