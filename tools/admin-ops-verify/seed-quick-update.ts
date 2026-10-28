// Seeds a tenant with one hotel, three rate plans (two in AED sharing dates/prices for multi-plan scope, one in GBP to exercise the
// single-currency guard) and a second tenant with one hotel, for the Admin Quick Update (ADR 0021 stage 5 / ADR 0067) browser and API
// certification. Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const tag = `qu-${Date.now()}`
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

  const hotel = await prisma.hotel.create({ data: { tenantId: A, name: 'Quick Update Hotel', externalRef: `QU-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5, timeZone: 'Asia/Dubai' } })
  const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe Room', code: 'DLX', maxAdults: 3, maxChildren: 2, maxOccupancy: 4 } })
  const contract = await prisma.contract.create({ data: { tenantId: A, supplierId: supplierA, code: `${tag}-c1`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })

  const range = Array.from({ length: 90 }, (_, i) => utc(i - 2))
  const plan = async (code: string, currency: string, amount: bigint) => {
    const p = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract.id, roomTypeId: room.id, boardBasisId: boardA, code, status: 'ACTIVE', occupancy: 2, currency, minStay: 1 } })
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: amount, currency, amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, allotment: 10, sold: 0 })) })
    return p
  }
  const main = await plan(`QU-MAIN-${tag.slice(-4)}`, 'AED', 50_000n)
  const second = await plan(`QU-SECOND-${tag.slice(-4)}`, 'AED', 50_000n)
  const gbp = await plan(`QU-GBP-${tag.slice(-4)}`, 'GBP', 40_000n)
  // A DRAFT plan: never writable by Quick Update (WRITABLE_PLAN_STATUSES excludes it), used to show an INVALID row rather than a crash.
  const draft = await prisma.ratePlan.create({ data: { tenantId: A, contractId: contract.id, roomTypeId: room.id, boardBasisId: boardA, code: `QU-DRAFT-${tag.slice(-4)}`, status: 'DRAFT', occupancy: 2, currency: 'AED', minStay: 1 } })
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: draft.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })

  // Tenant B: one hotel, one plan, for the cross-tenant direct-API check.
  const hotelB = await prisma.hotel.create({ data: { tenantId: B, name: 'Other Tenant Hotel', externalRef: `QUB-${tag.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4, timeZone: 'Asia/Dubai' } })
  const roomB = await prisma.roomType.create({ data: { hotelId: hotelB.id, name: 'Standard Room', code: 'STD', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
  const contractB = await prisma.contract.create({ data: { tenantId: B, supplierId: supplierB, code: `${tag}-cb`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED' } })
  const planB = await prisma.ratePlan.create({ data: { tenantId: B, contractId: contractB.id, roomTypeId: roomB.id, boardBasisId: boardB, code: `QU-B-${tag.slice(-4)}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: B, ratePlanId: planB.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })

  const perms = ['supply.rates.read', 'supply.rates.manage', 'supply.availability.manage', 'supply.hotels.read']
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
  const viewer = await user('viewer', A, ['supply.rates.read', 'supply.hotels.read'])
  const bowner = await user('bowner', B, perms, 'owner')

  const out = { password, ownerEmail: owner.email, viewerEmail: viewer.email, bownerEmail: bowner.email, tenantA: A, tenantB: B, hotelId: hotel.id, hotelBId: hotelB.id, plans: { main: main.id, second: second.id, gbp: gbp.id, draft: draft.id, b: planB.id }, mainCode: main.code, secondCode: second.code, gbpCode: gbp.code, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-quick-update.json', JSON.stringify(out, null, 2))
  console.log('seeded quick-update fixtures:', hotel.id)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
