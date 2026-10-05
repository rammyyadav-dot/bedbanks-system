// Seeds a tenant with one hotel per rate-audit scenario (clean, zero amount, NET without markup, gap, inactive plan, logical duplicate,
// unverified basis, wrong currency, recorded markets, bad code format, other-occupancy rows, NET with a markup rule), a viewer holding only
// supply.hotels.read, and a second tenant with one defective hotel, for the Admin rate certification browser check.
// Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  // Zero-amount rows are legacy data (DailyRate_amount_positive, ADR 0034): lift the constraint while seeding them, then restore it NOT VALID as the migration leaves it.
  await prisma.$executeRawUnsafe('ALTER TABLE "DailyRate" DROP CONSTRAINT IF EXISTS "DailyRate_amount_positive"')
  const tag = `rc-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (offset: number) => new Date(base + offset * 86_400_000)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const supplier = async (tenantId: string, name: string) => (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const sA = await supplier(A, 'Gulf Direct'); const sB = await supplier(B, 'Other Supplier')
  const boardA = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const boardB = (await prisma.boardBasis.create({ data: { tenantId: B, code: 'BB', name: 'Bed and breakfast' } })).id

  type O = { tenant?: 'A' | 'B'; amount?: bigint; zeroDays?: number[]; basis?: 'SELL' | 'NET' | null; currency?: string; rateEnd?: number; plan?: 'ACTIVE' | 'DRAFT'; duplicate?: boolean; code?: string; markets?: string[]; extraOccupancy?: boolean }
  const hotels: Record<string, { id: string; planId: string }> = {}
  async function hotel(key: string, name: string, o: O = {}) {
    const tenantId = o.tenant === 'B' ? B : A; const supplierId = o.tenant === 'B' ? sB : sA; const boardBasisId = o.tenant === 'B' ? boardB : boardA
    const h = await prisma.hotel.create({ data: { tenantId, name, externalRef: `${key.toUpperCase()}-${tag.slice(-4)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe Sea View', code: `D-${key}`.slice(0, 30), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: m.id, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED', salesMarkets: o.markets ?? [] } })
    const range = Array.from({ length: 106 }, (_, i) => i - 3).filter((offset) => offset <= (o.rateEnd ?? 102))
    const codes = o.duplicate ? [`${key.toUpperCase()}-BB`, `${key.toUpperCase()}-BB-COPY`] : [o.code ?? `${key.toUpperCase()}-BB`]
    for (const code of codes) {
      const p = await prisma.ratePlan.create({ data: { tenantId, contractId: c.id, roomTypeId: room.id, boardBasisId, code, status: o.plan ?? 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
      hotels[key] ??= { id: h.id, planId: p.id }
      await prisma.dailyRate.createMany({ data: range.map((offset) => ({ tenantId, ratePlanId: p.id, stayDate: utc(offset), occupancy: 2, amountMinor: (o.zeroDays ?? []).includes(offset) ? 0n : o.amount ?? 49_900n, currency: o.currency ?? 'AED', amountBasis: o.basis === undefined ? 'SELL' as const : o.basis })) })
      if (o.extraOccupancy) await prisma.dailyRate.createMany({ data: range.slice(0, 10).map((offset) => ({ tenantId, ratePlanId: p.id, stayDate: utc(offset), occupancy: 3, amountMinor: 69_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: Array.from({ length: 106 }, (_, i) => ({ tenantId, ratePlanId: p.id, stayDate: utc(i - 3), allotment: 6, sold: 0 })) })
    }
  }
  await hotel('alpha', 'Aurora Grand Hotel')
  await hotel('bravo', 'Bay Zero Hotel', { zeroDays: [12, 13, 14] })
  await hotel('charlie', 'Creek NET Hotel', { basis: 'NET' })
  await hotel('delta', 'Dune Gap Hotel', { rateEnd: 40 })
  await hotel('echo', 'Emerald Inactive Hotel', { plan: 'DRAFT' })
  await hotel('foxtrot', 'Falcon Duplicate Hotel', { duplicate: true })
  await hotel('golf', 'Gulf Unverified Hotel', { basis: null })
  await hotel('hotel', 'Harbour USD Hotel', { currency: 'USD' })
  await hotel('india', 'Indigo Markets Hotel', { markets: ['GB', 'DE'] })
  await hotel('juliet', 'Jade Format Hotel', { code: 'jade standard' })
  await hotel('kilo', 'Koral Other Occupancy Hotel', { extraOccupancy: true })
  await hotel('lima', 'Lagoon NET Priced Hotel', { basis: 'NET' })
  await hotel('oscar', 'Other Tenant Hotel', { tenant: 'B', zeroDays: [10] })

  const perms = ['supply.rates.read', 'supply.hotels.read', 'supply.contracts.read', 'supply.mappings.read', 'supply.suppliers.read']
  async function user(label: string, tenantId: string, keys: string[], role = 'agent') {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return { email, id: u.id }
  }
  const owner = await user('owner', A, perms, 'owner'); const viewer = await user('viewer', A, ['supply.hotels.read']); const bowner = await user('bowner', B, perms, 'owner')
  // a HOTEL-scope rule only for lima: charlie's NET rates stay unpriced
  await prisma.commercialMarkupRule.create({ data: { tenantId: A, scope: 'HOTEL', hotelId: hotels.lima.id, basisPoints: 1000, validFrom: utc(-30), status: 'ACTIVE', reason: 'verification fixture', createdById: owner.id, activatedAt: new Date() } })
  await prisma.$executeRawUnsafe('ALTER TABLE "DailyRate" ADD CONSTRAINT "DailyRate_amount_positive" CHECK (amount_minor > 0) NOT VALID')
  const out = { password, ownerEmail: owner.email, viewerEmail: viewer.email, bownerEmail: bowner.email, hotels, tenantA: A, tenantB: B, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-rate-certification.json', JSON.stringify(out, null, 2))
  console.log('seeded', Object.keys(hotels).length, 'hotels')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
