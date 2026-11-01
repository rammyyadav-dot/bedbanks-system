import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { PrismaService } from '../src/database/prisma.service'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'

jest.setTimeout(180_000)

/**
 * ADR 0035: contract sales markets (buyer agency country) and guest nationalities restrict Agent search and recheck, fail closed.
 * Real PostgreSQL, real adapter. Dates are relative to today (UTC).
 */
describe('contract sales-market and nationality enforcement (PostgreSQL)', () => {
  const prisma = new PrismaClient()
  const suffix = `mkt-${Date.now()}-${randomBytes(3).toString('hex')}`
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const checkIn = day(20); const checkOut = day(22); const nights = [checkIn, day(21)]
  let tenantA = '', tenantB = '', supplierId = '', boardId = ''
  const users: Record<string, string> = {}
  const hotels: Record<string, string> = {}
  const created = { agencies: [] as string[], userIds: [] as string[] }
  const criteria = (nationality = 'IN'): SearchCriteria => ({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality, currency: 'AED' })
  const adapterFor = (client: PrismaClient | PrismaService) => new ContractedInventoryAdapter(client as PrismaService)
  const adapter = adapterFor(new PrismaService())
  const search = async (who: keyof typeof users | undefined, nationality = 'IN', a = adapter): Promise<Record<string, SearchRateOffer>> => {
    const result = await a.search(criteria(nationality), { tenantId: tenantA, requestId: 'r', ...(who ? { userId: users[who] } : {}) })
    return Object.fromEntries(result.offers.flatMap((h) => h.rooms.flatMap((r) => r.rates.map((rate) => [Object.keys(hotels).find((k) => hotels[k] === h.hotelId) ?? h.hotelId, rate]))))
  }
  const names = async (who: keyof typeof users | undefined, nationality = 'IN', a = adapter) => Object.keys(await search(who, nationality, a)).sort()

  async function hotel(key: string, rules: { salesMarkets?: unknown; nationalities?: unknown }, tenantId = tenantA) {
    const h = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: h.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: m.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: new Date(Date.now() - 400 * 86_400_000), validTo: new Date(Date.now() + 4000 * 86_400_000), settlementCurrency: 'AED', ...(rules.salesMarkets !== undefined ? { salesMarkets: rules.salesMarkets as never } : {}), ...(rules.nationalities !== undefined ? { nationalities: rules.nationalities as never } : {}) } })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: c.id, roomTypeId: room.id, boardBasisId: boardId, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    await prisma.dailyRate.createMany({ data: nights.map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), occupancy: 2, amountMinor: 50_000n, amountBasis: 'SELL' as const, currency: 'AED' })) })
    await prisma.dailyAvailability.createMany({ data: [...nights, checkOut].map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), allotment: 5 })) })
    hotels[key] = h.id
  }
  async function agent(label: string, country: string | null | 'NONE') {
    const u = await prisma.user.create({ data: { email: `${suffix}-${label}@example.test` } })
    created.userIds.push(u.id); users[label] = u.id
    if (country === 'NONE') return
    const a = await prisma.agency.create({ data: { tenantId: tenantA, code: `${label}-${suffix.slice(-6)}`.toUpperCase(), name: label, countryCode: country, createdById: u.id } })
    created.agencies.push(a.id)
    await prisma.agencyMember.create({ data: { tenantId: tenantA, agencyId: a.id, userId: u.id } })
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    await hotel('open', {})                                                       // no lists: everyone
    await hotel('gbonly', { salesMarkets: ['GB'] })                               // GB agencies only
    await hotel('frnat', { nationalities: ['fr'] })                               // French guests only (stored lower case: normalized)
    await hotel('gbin', { salesMarkets: ['GB'], nationalities: ['IN'] })          // both lists
    await hotel('junk', { salesMarkets: 'not-a-list' })                           // malformed: sold to nobody
    await agent('gb', 'GB'); await agent('de', 'DE'); await agent('nocountry', null); await agent('noagency', 'NONE')
  })

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.dailyRate.deleteMany({ where: { tenantId } }); await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } }); await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } }); await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } }); await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
      await prisma.hotel.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.agencyMember.deleteMany({ where: { tenantId } }); await prisma.agency.deleteMany({ where: { tenantId } })
    }
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  it('MK-01 a GB agency with an Indian guest sees open, GB-only and the GB+IN contract; the French-only and malformed contracts stay hidden', async () => {
    expect(await names('gb', 'IN')).toEqual(['gbin', 'gbonly', 'open'])
  })

  it('MK-02 the guest nationality is applied: the same GB agency with a French guest sees the French contract but not the GB+IN one', async () => {
    expect(await names('gb', 'FR')).toEqual(['frnat', 'gbonly', 'open'])
    expect(await names('gb', 'fr')).toEqual(['frnat', 'gbonly', 'open']) // case-insensitive
  })

  it('MK-03 a DE agency never sees a GB-only contract, whatever the guest nationality', async () => {
    expect(await names('de', 'IN')).toEqual(['open'])
    expect(await names('de', 'FR')).toEqual(['frnat', 'open'])
  })

  it('MK-04 an unknown market fails closed: an agency without a country, a user without an agency and an anonymous search see only open contracts', async () => {
    for (const who of ['nocountry', 'noagency', undefined] as const) expect(await names(who, 'IN')).toEqual(['open'])
  })

  it('MK-05 a malformed list is sold to nobody (not to everybody), in every buyer context', async () => {
    for (const who of ['gb', 'de', 'nocountry', 'noagency'] as const) expect(await names(who, 'FR')).not.toContain('junk')
  })

  it('MK-06 prices are unaffected: an allowed contract is priced exactly as an open one', async () => {
    const found = await search('gb', 'IN')
    expect(found.gbonly.sellAmountMinor).toBe(found.open.sellAmountMinor)
    expect(found.gbin.sellAmountMinor).toBe(100_000)
  })

  it('MK-07 recheck applies the same rule to the same buyer: an offer found by a GB agency rechecks for it and is unavailable for a DE agency', async () => {
    const result = await adapter.search(criteria('IN'), { tenantId: tenantA, requestId: 'r', userId: users.gb })
    const offer = result.offers.find((h) => h.hotelId === hotels.gbin)!.rooms[0].rates[0]
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId: tenantA, requestId: 'r', userId: users.gb })).toMatchObject({ status: 'available', offer: { sellAmountMinor: 100_000 } })
    for (const who of ['de', 'nocountry', 'noagency']) expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId: tenantA, requestId: 'r', userId: users[who] })).toEqual({ status: 'unavailable' })
  })

  it('MK-08 recheck remembers the searched nationality: it is no longer the hard-coded AE', async () => {
    const result = await adapter.search(criteria('IN'), { tenantId: tenantA, requestId: 'r', userId: users.gb })
    const offer = result.offers.find((h) => h.hotelId === hotels.gbin)!.rooms[0].rates[0]
    // the stored offer carries nationality IN, so the nationality-restricted contract still rechecks; a contract edited to need another nationality does not
    await prisma.contract.updateMany({ where: { tenantId: tenantA, code: `${suffix}-gbin` }, data: { nationalities: ['FR'] } })
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId: tenantA, requestId: 'r', userId: users.gb })).toEqual({ status: 'unavailable' })
    await prisma.contract.updateMany({ where: { tenantId: tenantA, code: `${suffix}-gbin` }, data: { nationalities: ['IN'] } })
    expect((await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId: tenantA, requestId: 'r', userId: users.gb })).status).toBe('available')
  })

  it('MK-09 editing a contract list takes effect on the next search, and clearing it reopens the contract', async () => {
    await prisma.contract.updateMany({ where: { tenantId: tenantA, code: `${suffix}-gbonly` }, data: { salesMarkets: ['DE'] } })
    expect(await names('de', 'IN')).toEqual(['gbonly', 'open']); expect(await names('gb', 'IN')).toEqual(['gbin', 'open'])
    await prisma.contract.updateMany({ where: { tenantId: tenantA, code: `${suffix}-gbonly` }, data: { salesMarkets: [] } })
    expect(await names('de', 'IN')).toEqual(['gbonly', 'open'])
    await prisma.contract.updateMany({ where: { tenantId: tenantA, code: `${suffix}-gbonly` }, data: { salesMarkets: ['GB'] } })
  })

  it('MK-10 strict runtime role: the same answers on the non-bypass role, and an unreadable Agency table fails closed only when a contract restricts markets', async () => {
    const owner = new PrismaClient(); const password = randomBytes(24).toString('hex'); const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password })
      const u = new URL(previous as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = password
      runtime = new PrismaService({ datasourceUrl: u.toString() } as never)
      await runtime.$connect()
      const strict = adapterFor(runtime)
      expect(await names('gb', 'IN', strict)).toEqual(['gbin', 'gbonly', 'open'])
      expect(await names('de', 'IN', strict)).toEqual(['open'])
      await owner.$executeRawUnsafe('REVOKE SELECT ON "Agency" FROM fbeds_api')
      try {
        await expect(strict.search(criteria('IN'), { tenantId: tenantA, requestId: 'r', userId: users.gb })).rejects.toMatchObject({ code: 'commercial_control_unavailable' })
      } finally { await provisionApiRuntimeRole(owner, { password }) }
      expect(await names('gb', 'IN', strict)).toEqual(['gbin', 'gbonly', 'open'])
    } finally { await runtime?.$disconnect(); await owner.$disconnect() }
  })
})
