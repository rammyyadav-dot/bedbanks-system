// Seeds a tenant with: (1) an ACTIVE contract carrying a BOARD and a COMPULSORY supplement and one ACTIVE rate plan with SELL rates, for
// pricing-math certification of promotions and supplements together (ADR 0089 / ADR 0067); (2) a DRAFT contract with no supplements yet,
// for the Admin UI's add/remove supplement flow; and a second tenant, for the cross-tenant checks. For the Admin promotions and
// commercial-policy browser/API certification. Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const tag = `ps-${Date.now()}`
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

  const hotel = await prisma.hotel.create({ data: { tenantId: A, name: 'Promotions Hotel', externalRef: `PS-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5, timeZone: 'Asia/Dubai' } })
  const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe Room', code: 'DLX', maxAdults: 3, maxChildren: 1, maxOccupancy: 4 } })

  // Contract 1: ACTIVE, with a BOARD supplement (charged every night) and a COMPULSORY supplement (charged once per stay), for pricing math.
  const contract1 = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c1`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  await prisma.contractSupplement.create({ data: { contractId: contract1.id, kind: 'BOARD', name: 'Breakfast', boardBasisId: boardA, basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: 5_000n, currency: 'AED' } })
  await prisma.contractSupplement.create({ data: { contractId: contract1.id, kind: 'COMPULSORY', name: 'Resort fee', boardBasisId: null, basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: 2_000n, currency: 'AED' } })
  const plan = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract1.id, roomTypeId: room.id, boardBasisId: boardA, code: `PROMO-MAIN-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  const range = Array.from({ length: 120 }, (_, i) => utc(i - 2))
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
  await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: plan.id, stayDate, allotment: 10, sold: 0 })) })

  // Contract 2: DRAFT (termsEditable), no rate plans needed — only the UI's add/remove supplement flow and API validation are exercised.
  const contract2 = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c2`, status: 'DRAFT', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })

  // Tenant B: one hotel, contract and plan, for the cross-tenant checks.
  const hotelB = await prisma.hotel.create({ data: { tenantId: B, name: 'Other Tenant Hotel', externalRef: `PSB-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4, timeZone: 'Asia/Dubai' } })
  const roomB = await prisma.roomType.create({ data: { hotelId: hotelB.id, name: 'Standard Room', code: 'STD', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
  const contractB = await prisma.contract.create({ data: { tenantId: B, supplierId: supplierB, code: `${tag}-cb`, status: 'DRAFT', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  const planB = await prisma.ratePlan.create({ data: { tenantId: B, contractId: contractB.id, roomTypeId: roomB.id, boardBasisId: boardB, code: `PROMO-B-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })

  const perms = ['supply.rates.read', 'supply.rates.manage', 'supply.contracts.read', 'supply.contracts.manage', 'supply.hotels.read']
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
  const viewer = await user('viewer', A, ['supply.rates.read', 'supply.hotels.read'])
  const bowner = await user('bowner', B, perms, 'owner')

  const out = { password, makerEmail: maker.email, checkerEmail: checker.email, viewerEmail: viewer.email, bownerEmail: bowner.email, tenantA: A, tenantB: B, hotelId: hotel.id, planId: plan.id, planCode: plan.code, contract1Id: contract1.id, contract2Id: contract2.id, contractBId: contractB.id, planBId: planB.id, boardA, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-promotions-supplements.json', JSON.stringify(out, null, 2))
  console.log('seeded promotions-supplements fixtures:', hotel.id)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
