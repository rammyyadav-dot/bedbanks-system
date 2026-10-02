import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { CONTRACT_EXPIRING_DAYS } from '@bedbanks/contracts'

jest.setTimeout(120_000)

/**
 * Hotel Commercial 360 over HTTP, against the real AppModule and PostgreSQL, with two tenants.
 * Dates are all relative to today (UTC), so nothing here expires as the calendar moves.
 */
describe('hotel commercial operations (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `hc-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'hotel-commercial-certification-password'
  const ymd = (offset: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + offset * 86_400_000
  const day = (offset: number) => new Date(ymd(offset)).toISOString().slice(0, 10)
  const utc = (offset: number) => new Date(ymd(offset))
  const FROM = day(10); const DAYS = 5 // assessed window: d+10 .. d+14
  const win = `from=${FROM}&days=${DAYS}`
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', boardA = '', boardB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const hotels: Record<string, { id: string; name: string; code: string; roomId: string; planId: string; contractId: string }> = {}

  interface Opts {
    city?: string; stars?: number | null; content?: string; mapping?: 'MAPPED' | 'PENDING' | 'REJECTED' | 'NONE'; roomMapped?: boolean
    validFrom?: number; validTo?: number; contractStatus?: 'ACTIVE' | 'DRAFT'; rates?: boolean; availability?: boolean; stopSellDays?: number[]; allotment?: number; sold?: number
    plan?: 'ACTIVE' | 'DRAFT' | 'NONE'; tenant?: 'A' | 'B'; minStay?: number; rateMinor?: bigint
  }
  async function makeHotel(key: string, o: Opts = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const supplierId = o.tenant === 'B' ? supplierB : supplierA
    const boardBasisId = o.tenant === 'B' ? boardB : boardA
    const name = `${suffix} ${key}`; const code = `${key.toUpperCase().slice(0, 4)}-${suffix.slice(-6)}`
    const hotel = await prisma.hotel.create({ data: { tenantId, name, externalRef: code, propertyType: 'HOTEL', city: o.city ?? 'Dubai', countryCode: 'AE', contentStatus: (o.content ?? 'COMPLETE') as never, starRating: o.stars === undefined ? 5 : o.stars } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = (o.mapping ?? 'MAPPED') === 'NONE' ? null : await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: (o.mapping ?? 'MAPPED') as 'MAPPED' | 'PENDING' | 'REJECTED' } })
    if (mapping && o.roomMapped !== false) await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping?.id ?? null, code: `${suffix}-${key}`, status: o.contractStatus ?? 'ACTIVE', validFrom: utc(o.validFrom ?? -400), validTo: utc(o.validTo ?? 4000), settlementCurrency: 'AED' } })
    let planId = ''
    if ((o.plan ?? 'ACTIVE') !== 'NONE') {
      const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`.slice(0, 40), status: (o.plan ?? 'ACTIVE') as never, occupancy: 2, currency: 'AED', minStay: o.minStay ?? 1 } })
      planId = plan.id
      const range = Array.from({ length: 16 }, (_, i) => utc(8 + i))
      if (o.rates !== false) await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: o.rateMinor ?? 45_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
      if (o.availability !== false) await prisma.dailyAvailability.createMany({ data: range.map((stayDate, i) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: o.allotment ?? 5, sold: o.sold ?? 0, stopSell: (o.stopSellDays ?? []).includes(8 + i) })) })
    }
    hotels[key] = { id: hotel.id, name, code, roomId: room.id, planId, contractId: contract.id }
    return hotels[key]
  }

  async function user(label: string, tenantId: string, permissionKeys: string[], role = 'agent') {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role } })
    if (permissionKeys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of permissionKeys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const get = (path: string, who = 'owner') => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const supplyKeys = ['supply.hotels.read', 'supply.contracts.read', 'supply.mappings.read', 'supply.rates.read', 'supply.suppliers.read', 'audit.read', 'booking.read', 'hotel.search']

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Supplier Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await prisma.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sB`, displayName: 'Supplier Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    boardA = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'Bed and breakfast' } })).id
    boardB = (await prisma.boardBasis.create({ data: { tenantId: tenantB, code: 'BB', name: 'Bed and breakfast' } })).id

    await makeHotel('alpha')                                              // A  sellable
    await makeHotel('bravo', { stopSellDays: [11] })                      // PARTIAL: one stop-sold night
    await makeHotel('charlie', { mapping: 'PENDING', roomMapped: false }) // hotel mapping not approved
    await makeHotel('delta', { roomMapped: false })                       // room mapping missing
    await makeHotel('echo', { validFrom: -400, validTo: -5 })             // contract ended
    await makeHotel('foxtrot', { rates: false })                          // rate missing
    await makeHotel('golf', { availability: false })                      // availability missing
    await makeHotel('hotel', { stopSellDays: [10, 11, 12, 13, 14] })      // stop sell on every assessed night
    await makeHotel('india', { allotment: 2, sold: 2 })                   // inventory exhausted
    await makeHotel('juliet', { validTo: 20 })                            // contract expiring (still sellable in the window)
    await makeHotel('kilo', { plan: 'NONE', mapping: 'NONE', stars: null, content: 'DRAFT' }) // brand-new hotel: nothing configured
    await makeHotel('lima', { stars: null })                              // no star rating: invisible to Agents
    await makeHotel('mike', { city: 'Abu Dhabi' })                        // other destination
    await makeHotel('november', { allotment: 1 })                         // will receive an active hold
    await makeHotel('oscar', { tenant: 'B' })                             // tenant B's only hotel
    await prisma.cancellationPolicy.create({ data: { contractId: hotels.alpha.contractId, daysBeforeCheckin: 7, penaltyPercent: 0 } })

    const owner = await user('owner', tenantA, supplyKeys, 'owner')
    const viewer = await user('viewer', tenantA, ['supply.hotels.read'])
    const none = await user('none', tenantA, [])
    const bowner = await user('bowner', tenantB, supplyKeys, 'owner')

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.owner = await login(owner); cookies.viewer = await login(viewer); cookies.none = await login(none); cookies.bowner = await login(bowner)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.booking.deleteMany({ where: { tenantId } })
      await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
      await prisma.inventoryHold.deleteMany({ where: { tenantId } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.cancellationPolicy.deleteMany({ where: { contract: { tenantId } } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  const list = async (qs = '', who = 'owner') => (await get(`/hotels?${win}&pageSize=100${qs ? `&${qs}` : ''}`, who).expect(200)).body.data
  const rowOf = async (key: string) => (await list(`search=${encodeURIComponent(hotels[key].name)}`)).items.find((h: { id: string }) => h.id === hotels[key].id)
  const detail = async (key: string, who = 'owner') => (await get(`/hotels/${hotels[key].id}?${win}`, who).expect(200)).body.data

  // ---- list ----------------------------------------------------------------------------------------------------------------
  it('HOTEL-OPS-01: the list is authoritative: identity, destination, supplier, contract state, mapping and rooms per hotel', async () => {
    const page = await list()
    expect(page.total).toBe(14) // tenant A only (15 hotels were created, one belongs to tenant B)
    expect(page.items.map((h: { name: string }) => h.name)).toEqual([...page.items.map((h: { name: string }) => h.name)].sort((a, b) => a.localeCompare(b)))
    const alpha = page.items.find((h: { id: string }) => h.id === hotels.alpha.id)
    expect(alpha).toMatchObject({ code: hotels.alpha.code, city: 'Dubai', countryCode: 'AE', starRating: 5, contentStatus: 'COMPLETE', readiness: 'READY', hotelMapping: 'MAPPED', contractState: 'ACTIVE', rates: 'OK', inventory: 'OK', rooms: { total: 1, active: 1, mapped: 1 }, ratePlans: { total: 1, active: 1 }, issues: { total: 0, critical: 0, high: 0, warning: 0 }, blockers: [] })
    expect(alpha.suppliers).toEqual([{ id: supplierA, displayName: 'Supplier Alpha' }])
    expect(page.window).toEqual({ from: FROM, to: day(14), days: DAYS })
    expect(page.destinations).toEqual(['Abu Dhabi', 'Dubai'])
    // entity status is not commercial readiness
    expect((await rowOf('charlie')).contentStatus).toBe('COMPLETE')
    expect((await rowOf('charlie')).readiness).toBe('BLOCKED')
  })

  it('HOTEL-OPS-02: server-side pagination: first, middle and final pages, an empty page, and stable ordering', async () => {
    const seen: string[] = []
    for (const [page, expected] of [[1, 5], [2, 5], [3, 4]] as const) {
      const body = (await get(`/hotels?${win}&page=${page}&pageSize=5`).expect(200)).body.data
      expect(body).toMatchObject({ page, pageSize: 5, total: 14 })
      expect(body.items).toHaveLength(expected)
      seen.push(...body.items.map((h: { id: string }) => h.id))
    }
    expect(new Set(seen).size).toBe(14)
    const beyond = (await get(`/hotels?${win}&page=4&pageSize=5`).expect(200)).body.data
    expect(beyond).toMatchObject({ total: 14, items: [] }) // a real, successful empty page
    await get('/hotels?pageSize=101').expect(400); await get('/hotels?page=0').expect(400)
  })

  it('HOTEL-OPS-03: search by name or code, combined with pagination; wildcard characters are literal', async () => {
    expect((await list(`search=${encodeURIComponent(hotels.mike.name)}`)).items.map((h: { id: string }) => h.id)).toEqual([hotels.mike.id])
    expect((await list(`search=${encodeURIComponent(hotels.mike.code.slice(0, 6))}`)).items.map((h: { id: string }) => h.id)).toContain(hotels.mike.id)
    const paged = (await get(`/hotels?${win}&search=${encodeURIComponent(suffix)}&page=2&pageSize=10`).expect(200)).body.data
    expect(paged).toMatchObject({ total: 14, page: 2 }); expect(paged.items).toHaveLength(4)
    for (const wildcard of ['%', '_', '%%', '\\']) expect((await list(`search=${encodeURIComponent(wildcard)}`)).total).toBe(0)
  })

  it('LIKE wildcards are literal in every free-text filter, including the transaction and supplier filters from the earlier Admin work', async () => {
    for (const wildcard of ['%', '_']) {
      const e = encodeURIComponent(wildcard)
      expect((await get(`/suppliers?search=${e}`).expect(200)).body.data.total).toBe(0)
      expect((await get(`/audit?action=${e}`).expect(200)).body.data.total).toBe(0)
      if (wildcard === '%') await get(`/bookings?reference=${e}`).expect(400) // not an identifier character
      else expect((await get(`/bookings?reference=${e}`).expect(200)).body.data.total).toBe(0) // '_' is allowed, and literal
    }
    expect((await get('/suppliers?search=Supplier').expect(200)).body.data.total).toBe(1) // a real prefix still matches
  })

  it('HOTEL-OPS-04: destination and supplier filters apply on the server, together with pagination', async () => {
    const abu = await list('destination=Abu%20Dhabi')
    expect(abu.items.map((h: { id: string }) => h.id)).toEqual([hotels.mike.id])
    const dubai = (await get(`/hotels?${win}&destination=dubai&page=1&pageSize=5`).expect(200)).body.data
    expect(dubai.total).toBe(13); expect(dubai.items).toHaveLength(5)
    expect((await list(`supplierId=${supplierA}`)).total).toBe(13) // the brand-new hotel has no mapping or contract, so no supplier
    expect((await list(`supplierId=${supplierB}`)).total).toBe(0) // another tenant's supplier matches nothing here
    expect((await list('contentStatus=DRAFT')).items.map((h: { id: string }) => h.id)).toEqual([hotels.kilo.id])
  })

  // ---- readiness -----------------------------------------------------------------------------------------------------------
  it('HOTEL-OPS-05/06/07: READY, PARTIAL and BLOCKED are computed by the API and can be filtered', async () => {
    expect((await rowOf('alpha')).readiness).toBe('READY')
    const bravo = await rowOf('bravo')
    expect(bravo).toMatchObject({ readiness: 'PARTIAL', inventory: 'STOP_SELL' }); expect(bravo.blockers).toEqual(['STOP_SELL'])
    expect((await rowOf('hotel')).readiness).toBe('BLOCKED')
    const ready = (await list('readiness=READY')).items.map((h: { id: string }) => h.id)
    expect(ready).toEqual(expect.arrayContaining([hotels.alpha.id, hotels.juliet.id, hotels.mike.id]))
    expect(ready).not.toContain(hotels.bravo.id)
    expect((await list('readiness=PARTIAL')).items.map((h: { id: string }) => h.id)).toEqual([hotels.bravo.id])
    expect((await list('readiness=BLOCKED')).total).toBe(14 - ready.length - 1)
    await get('/hotels?readiness=NOT_A_STATE').expect(400)
  })

  it('HOTEL-OPS summary: aggregates are authoritative over every hotel, not the loaded page', async () => {
    const s = (await get(`/hotels/summary?${win}`).expect(200)).body.data
    expect(s.totalHotels).toBe(14); expect(s.scanCapped).toBe(false)
    expect(s.readiness.ready + s.readiness.partial + s.readiness.blocked).toBe(14)
    expect(s.readiness.partial).toBe(1)
    expect(s.mappingIssueHotels).toBeGreaterThanOrEqual(3) // charlie, delta, kilo
    expect(s.rateGapHotels).toBeGreaterThanOrEqual(1); expect(s.availabilityGapHotels).toBeGreaterThanOrEqual(1)
    expect(s.contractsExpiring).toBe(1); expect(s.contractsExpired).toBe(1); expect(s.contractExpiringDays).toBe(CONTRACT_EXPIRING_DAYS)
    expect(s.stopSellHotels).toBeGreaterThanOrEqual(2)
  })

  // ---- diagnostics ---------------------------------------------------------------------------------------------------------
  it('HOTEL-OPS-08: an unapproved hotel mapping blocks readiness, with the mapping view and a deep-linked issue', async () => {
    const row = await rowOf('charlie')
    expect(row).toMatchObject({ readiness: 'BLOCKED', hotelMapping: 'PENDING' }); expect(row.blockers).toContain('SUPPLIER_MAPPING_INVALID')
    expect((await list('mapping=PENDING')).items.map((h: { id: string }) => h.id)).toEqual([hotels.charlie.id])
    expect((await list('mapping=NONE')).items.map((h: { id: string }) => h.id)).toEqual([hotels.kilo.id])
    const d = await detail('charlie')
    expect(d.gates.find((g: { key: string }) => g.key === 'hotelMapping')).toMatchObject({ state: 'WARN', section: 'mappings' })
    expect(d.issues.find((i: { category: string }) => i.category === 'UNMAPPED_HOTEL')).toMatchObject({ severity: 'CRITICAL', reason: 'SUPPLIER_MAPPING_INVALID', section: 'mappings', supplierName: 'Supplier Alpha' })
    const m = (await get(`/hotels/${hotels.charlie.id}/mappings`).expect(200)).body.data
    expect(m.hotelMappings).toMatchObject([{ supplierName: 'Supplier Alpha', status: 'PENDING', supplierHotelId: `${suffix}-charlie` }])
    expect(m.unmappedRooms).toMatchObject([{ roomName: 'Deluxe' }])
  })

  it('HOTEL-OPS-09: a missing room mapping blocks the room, not silently inferred from names', async () => {
    const d = await detail('delta')
    expect(d.readiness).toBe('BLOCKED')
    expect(d.rooms[0]).toMatchObject({ name: 'Deluxe', mapping: 'NONE', supplierRoomIds: [], readiness: 'BLOCKED' })
    expect(d.gates.find((g: { key: string }) => g.key === 'roomMapping')).toMatchObject({ state: 'FAIL', detail: '0 / 1 active rooms mapped' })
    expect(d.issues.find((i: { category: string }) => i.category === 'UNMAPPED_ROOM')).toMatchObject({ roomName: 'Deluxe', section: 'mappings' })
    const m = (await get(`/hotels/${hotels.delta.id}/mappings`).expect(200)).body.data
    expect(m.roomMappings).toEqual([]); expect(m.unmappedRooms).toHaveLength(1)
    const ok = (await get(`/hotels/${hotels.alpha.id}/mappings`).expect(200)).body.data
    expect(ok.roomMappings).toMatchObject([{ roomName: 'Deluxe', status: 'MAPPED', supplierRoomId: `${suffix}-alpha-r` }]); expect(ok.unmappedRooms).toEqual([])
  })

  it('HOTEL-OPS-10: contract state is ACTIVE / EXPIRING / EXPIRED with one server threshold, and an ended contract blocks sale', async () => {
    expect(await rowOf('alpha')).toMatchObject({ contractState: 'ACTIVE' })
    expect(await rowOf('juliet')).toMatchObject({ contractState: 'EXPIRING', contractDaysToExpiry: 20, readiness: 'READY' })
    const echo = await rowOf('echo')
    expect(echo).toMatchObject({ contractState: 'EXPIRED', readiness: 'BLOCKED' }); expect(echo.blockers).toContain('OUTSIDE_CONTRACT_VALIDITY')
    expect((await list('contractState=EXPIRING')).items.map((h: { id: string }) => h.id)).toEqual([hotels.juliet.id])
    expect((await list('contractState=EXPIRED')).items.map((h: { id: string }) => h.id)).toEqual([hotels.echo.id])
    expect((await list('expiresWithinDays=30')).items.map((h: { id: string }) => h.id)).toEqual([hotels.juliet.id])
    expect((await list('expiresWithinDays=7')).total).toBe(0)
    expect((await list('expiresWithinDays=90')).items.map((h: { id: string }) => h.id)).toEqual([hotels.juliet.id])
    await get('/hotels?expiresWithinDays=45').expect(400)
    const c = (await get(`/hotels/${hotels.juliet.id}/contracts?${win}`).expect(200)).body.data
    expect(c.expiringDays).toBe(CONTRACT_EXPIRING_DAYS)
    expect(c.contracts[0]).toMatchObject({ code: `${suffix}-juliet`, supplierName: 'Supplier Alpha', status: 'ACTIVE', state: 'EXPIRING', daysToExpiry: 20, currency: 'AED', link: 'MAPPING', ratePlans: { total: 1, active: 1 } })
    expect(c.ratePlans[0]).toMatchObject({ code: 'juliet-BB', boardCode: 'BB', roomName: 'Deluxe', currency: 'AED', amountBasis: 'SELL', readiness: 'READY', occupancy: 2 })
    const a = (await get(`/hotels/${hotels.alpha.id}/contracts?${win}`).expect(200)).body.data
    expect(a.contracts[0].policies).toEqual({ cancellation: 1, child: 0, leadTime: 0 })
    const issue = (await detail('juliet')).issues.find((i: { category: string }) => i.category === 'CONTRACT_EXPIRING')
    expect(issue).toMatchObject({ severity: 'WARNING', section: 'contracts' })
  })

  it('HOTEL-OPS-11/12/13/14: missing rate, missing availability, stop-sell and exhausted inventory are each identified, with date ranges', async () => {
    const fox = await detail('foxtrot')
    expect(fox.issues.find((i: { category: string }) => i.category === 'RATE_MISSING')).toMatchObject({ reason: 'DAILY_RATE_MISSING_OR_INVALID', from: FROM, to: day(14), nights: 5, severity: 'CRITICAL' })
    const golf = await detail('golf')
    expect(golf.issues.find((i: { category: string }) => i.category === 'AVAILABILITY_MISSING')).toMatchObject({ reason: 'AVAILABILITY_MISSING', nights: 5 })
    const hot = await detail('hotel')
    expect(hot.issues.find((i: { category: string }) => i.category === 'STOP_SELL')).toMatchObject({ reason: 'STOP_SELL', from: FROM, to: day(14) })
    const ind = await detail('india')
    expect(ind.issues.find((i: { category: string }) => i.category === 'INVENTORY_EXHAUSTED')).toMatchObject({ reason: 'NO_INVENTORY', nights: 5 })
    expect(await rowOf('foxtrot')).toMatchObject({ rates: 'GAPS', readiness: 'BLOCKED' })
    expect(await rowOf('golf')).toMatchObject({ inventory: 'GAPS' })
    expect(await rowOf('hotel')).toMatchObject({ inventory: 'STOP_SELL' })
    expect(await rowOf('india')).toMatchObject({ inventory: 'EXHAUSTED' })
    expect((await list('issue=RATE_MISSING')).items.map((h: { id: string }) => h.id)).toEqual([hotels.foxtrot.id])
    expect((await list('issue=AVAILABILITY_MISSING')).items.map((h: { id: string }) => h.id)).toEqual([hotels.golf.id])
    expect((await list('issue=NO_INVENTORY')).items.map((h: { id: string }) => h.id)).toEqual([hotels.india.id])
    expect((await list('issue=STOP_SELL')).items.map((h: { id: string }) => h.id).sort()).toEqual([hotels.bravo.id, hotels.hotel.id].sort())
    await get('/hotels?issue=drop%20table').expect(400)
  })

  it('a brand-new hotel is never "ready": no plan, no mapping, no rating, DRAFT content', async () => {
    const d = await detail('kilo')
    expect(d.readiness).toBe('BLOCKED'); expect(d.agentSellable).toBe(false)
    expect(d.blockers).toEqual(expect.arrayContaining(['RATE_PLAN_MISSING']))
    expect(d.issues.every((i: { severity: string }) => i.severity === 'CRITICAL' || i.severity === 'HIGH')).toBe(true)
    expect(d.gates.find((g: { key: string }) => g.key === 'sellability').state).toBe('FAIL')
    expect(d.contractState).toBe('NONE'); expect(d.hotelMapping).toBe('NONE')
    const lima = await detail('lima')
    expect(lima.readiness).toBe('BLOCKED'); expect(lima.blockers).toContain('HOTEL_STAR_RATING_MISSING')
  })

  // ---- calendar, holds, money ------------------------------------------------------------------------------------------------
  it('HOTEL-OPS-19 / calendar: rate and inventory per plan and date, integer money, remaining = allotment - sold - held', async () => {
    const cal = (await get(`/hotels/${hotels.bravo.id}/calendar?from=${FROM}&days=5`).expect(200)).body.data
    expect(cal).toMatchObject({ hotelId: hotels.bravo.id, truncated: false, window: { from: FROM, days: 5 } })
    expect(cal.rows).toHaveLength(1)
    const row = cal.rows[0]
    expect(row).toMatchObject({ ratePlanCode: 'bravo-BB', roomName: 'Deluxe', boardCode: 'BB', currency: 'AED', occupancy: 2, supplierName: 'Supplier Alpha', planStatus: 'ACTIVE' })
    expect(row.cells.map((c: { date: string }) => c.date)).toEqual([0, 1, 2, 3, 4].map((i) => day(10 + i)))
    for (const cell of row.cells) { expect(cell.rateMinor).toMatch(/^\d+$/); expect(cell).toMatchObject({ rateMinor: '45000', currency: 'AED', amountBasis: 'SELL', allotment: 5, sold: 0, held: 0, remaining: 5 }) }
    expect(row.cells[1]).toMatchObject({ stopSell: true, sellable: false, reasons: ['STOP_SELL'] })
    expect(row.cells[0]).toMatchObject({ stopSell: false, sellable: true, reasons: [] })
    expect((await get(`/hotels/${hotels.bravo.id}/calendar?days=63`)).status).toBe(400)
    const none = (await get(`/hotels/${hotels.foxtrot.id}/calendar?from=${FROM}&days=2`).expect(200)).body.data.rows[0].cells
    expect(none[0]).toMatchObject({ rateMinor: null, currency: null, sellable: false }); expect(none[0].reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
    const gap = (await get(`/hotels/${hotels.golf.id}/calendar?from=${FROM}&days=2`).expect(200)).body.data.rows[0].cells
    expect(gap[0]).toMatchObject({ allotment: null, sold: null, held: null, remaining: null, stopSell: null }); expect(gap[0].reasons).toContain('AVAILABILITY_MISSING')
  })

  it('HOTEL-OPS-15 (DUBAI-15): an active hold consumes inventory without overselling, and is reflected in the hotel and its calendar', async () => {
    const holds = new InventoryHoldService(new PrismaService())
    const user = await prisma.user.findFirstOrThrow({ where: { email: `${suffix}-owner@example.test` } })
    const h = hotels.november
    const created = await holds.create({ tenantId: tenantA, userId: user.id, requestId: `${suffix}-h`, idempotencyKey: `${suffix}-h`, offerId: 'o', searchId: 's', ratePlanId: h.planId, canonicalHotelId: h.id, canonicalRoomTypeId: h.roomId, boardBasisId: boardA, checkIn: day(10), checkOut: day(12), rooms: 1, currency: 'AED', sellAmountMinor: 90_000, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const cal = (await get(`/hotels/${h.id}/calendar?from=${FROM}&days=4`).expect(200)).body.data.rows[0].cells
    expect(cal[0]).toMatchObject({ allotment: 1, sold: 0, held: 1, remaining: 0, sellable: false }); expect(cal[0].reasons).toContain('NO_INVENTORY')
    expect(cal[2]).toMatchObject({ held: 0, remaining: 1, sellable: true })
    const d = await detail('november')
    expect(d.readiness).toBe('PARTIAL'); expect(d.counts.activeHolds).toBe(1)
    const second = await holds.create({ tenantId: tenantA, userId: user.id, requestId: `${suffix}-h2`, idempotencyKey: `${suffix}-h2`, offerId: 'o2', searchId: 's2', ratePlanId: h.planId, canonicalHotelId: h.id, canonicalRoomTypeId: h.roomId, boardBasisId: boardA, checkIn: day(10), checkOut: day(11), rooms: 1, currency: 'AED', sellAmountMinor: 45_000, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }).catch((e: Error) => e)
    expect(second).toBeInstanceOf(Error) // the last room cannot be held twice
    const stillOne = (await get(`/hotels/${h.id}/calendar?from=${FROM}&days=1`).expect(200)).body.data.rows[0].cells[0]
    expect(stillOne.held).toBe(1); expect(stillOne.remaining).toBe(0)
    // link to the existing hold operations, filtered on the server
    const holdsList = (await get(`/holds?hotelId=${h.id}&status=HELD`).expect(200)).body.data
    expect(holdsList.items.map((x: { id: string }) => x.id)).toEqual([created.holdId])
    await holds.release(tenantA, created.holdId, `${suffix}-rel`, { type: 'USER', userId: user.id })
  })

  // ---- sellability inspector -----------------------------------------------------------------------------------------------
  it('HOTEL-OPS sellability inspector: a sellable stay shows PASS gates, offers and an integer total; a stay with one blocked night names the night', async () => {
    const q = (key: string, ci: number, co: number, children = 0) => `/hotels/${hotels[key].id}/sellability?checkIn=${day(ci)}&checkOut=${day(co)}&adults=2&children=${children}`
    const ok = (await get(q('alpha', 10, 13)).expect(200)).body.data
    expect(ok).toMatchObject({ sellable: true, offers: 1, cheapestMinor: '135000', currency: 'AED', hotelName: hotels.alpha.name })
    expect(ok.request).toMatchObject({ nights: 3, adults: 2, children: 0, rooms: 1 })
    expect(ok.plans[0]).toMatchObject({ sellable: true, totalMinor: '135000', reasons: [], ratePlanCode: 'alpha-BB' })
    expect(ok.plans[0].gates.every((g: { state: string }) => g.state === 'PASS')).toBe(true)
    expect(ok.plans[0].nights.map((n: { sellable: boolean }) => n.sellable)).toEqual([true, true, true])
    // bravo is stop-sold on d+11: a stay spanning it fails and the response says which night
    const bad = (await get(q('bravo', 10, 13)).expect(200)).body.data
    expect(bad).toMatchObject({ sellable: false, offers: 0, cheapestMinor: null })
    expect(bad.plans[0]).toMatchObject({ sellable: false, totalMinor: null }); expect(bad.plans[0].reasons).toContain('STOP_SELL')
    expect(bad.plans[0].nights.map((n: { date: string; sellable: boolean }) => [n.date, n.sellable])).toEqual([[day(10), true], [day(11), false], [day(12), true]])
    expect(bad.plans[0].nights[1].reasons).toEqual(['STOP_SELL'])
    expect(bad.plans[0].gates.find((g: { key: string }) => g.key === 'stopSell').state).toBe('FAIL')
    expect(bad.plans[0].gates.find((g: { key: string }) => g.key === 'rate').state).toBe('PASS')
    // a stay that avoids the stop-sold night is sellable
    expect((await get(q('bravo', 12, 14)).expect(200)).body.data.sellable).toBe(true)
    // stay-length rules belong here, not in readiness
    await prisma.ratePlan.update({ where: { id: hotels.alpha.planId }, data: { minStay: 3 } })
    const short = (await get(q('alpha', 10, 12)).expect(200)).body.data
    expect(short.sellable).toBe(false); expect(short.plans[0].reasons).toContain('MIN_STAY_NOT_MET')
    expect((await rowOf('alpha')).readiness).toBe('READY')
    await prisma.ratePlan.update({ where: { id: hotels.alpha.planId }, data: { minStay: 1 } })
    // validation
    for (const bad2 of [`/hotels/${hotels.alpha.id}/sellability?checkIn=${day(10)}&checkOut=${day(10)}&adults=2`, `/hotels/${hotels.alpha.id}/sellability?checkIn=${day(10)}&checkOut=${day(60)}&adults=2`, `/hotels/${hotels.alpha.id}/sellability?checkIn=${day(-3)}&checkOut=${day(-1)}&adults=2`, `/hotels/${hotels.alpha.id}/sellability?checkIn=${day(10)}&checkOut=${day(12)}`, `/hotels/${hotels.alpha.id}/sellability?checkIn=2026-02-31&checkOut=${day(12)}&adults=2`]) await get(bad2).expect(400)
    // an occupancy no plan supports is explained, not hidden
    const tri = (await get(q('alpha', 10, 12, 1)).expect(200)).body.data
    expect(tri.sellable).toBe(false); expect(tri.plans[0].reasons).toContain('OCCUPANCY_UNSUPPORTED')
  })

  it('AGENT CONSISTENCY: a hotel the Admin inspector calls sellable is offered by Agent search for the same stay, and a blocked one is not', async () => {
    const search = (checkIn: number, checkOut: number) => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies.owner)
      .send({ destination: 'Dubai', checkIn: day(checkIn), checkOut: day(checkOut), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
    const stay1 = (await search(10, 12).expect(201)).body.data.hotels.map((h: { name: string }) => h.name)
    const inspect = async (key: string, ci: number, co: number) => (await get(`/hotels/${hotels[key].id}/sellability?checkIn=${day(ci)}&checkOut=${day(co)}&adults=2&children=0`).expect(200)).body.data.sellable
    for (const key of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'lima', 'mike']) {
      if (key === 'mike') continue // different destination: Agent search is by destination
      expect({ key, agent: stay1.includes(hotels[key].name), admin: await inspect(key, 10, 12) }).toEqual({ key, agent: stay1.includes(hotels[key].name), admin: stay1.includes(hotels[key].name) })
    }
    expect(stay1).toContain(hotels.alpha.name); expect(stay1).not.toContain(hotels.charlie.name); expect(stay1).not.toContain(hotels.bravo.name)
    const stay2 = (await search(12, 14).expect(201)).body.data.hotels.map((h: { name: string }) => h.name)
    expect(stay2).toContain(hotels.bravo.name); expect(await inspect('bravo', 12, 14)).toBe(true)
  })

  // ---- exceptions ----------------------------------------------------------------------------------------------------------
  it('exceptions centre: deterministic severity order, filters, pagination, and every item carries a deep link and context', async () => {
    const all = (await get(`/exceptions?${win}&pageSize=100`).expect(200)).body.data
    expect(all.scanCapped).toBe(false)
    expect(all.counts.CRITICAL).toBeGreaterThan(0); expect(all.counts.WARNING).toBeGreaterThan(0)
    const rank = { CRITICAL: 0, HIGH: 1, WARNING: 2 } as Record<string, number>
    const ranks = all.items.map((i: { severity: string }) => rank[i.severity])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    for (const issue of all.items) expect(issue).toMatchObject({ hotelId: expect.any(String), hotelName: expect.any(String), message: expect.any(String), section: expect.stringMatching(/^(overview|rooms|mappings|contracts|rates|sellability)$/), observedAt: expect.any(String), id: expect.any(String) })
    expect(new Set(all.items.map((i: { id: string }) => i.id)).size).toBe(all.items.length)
    const again = (await get(`/exceptions?${win}&pageSize=100`).expect(200)).body.data
    expect(again.items.map((i: { id: string }) => i.id)).toEqual(all.items.map((i: { id: string }) => i.id)) // deterministic
    const stop = (await get(`/exceptions?${win}&category=STOP_SELL&pageSize=100`).expect(200)).body.data
    expect(stop.items.every((i: { category: string }) => i.category === 'STOP_SELL')).toBe(true)
    expect(stop.items.map((i: { hotelId: string }) => i.hotelId).sort()).toEqual([hotels.bravo.id, hotels.hotel.id].sort())
    const critical = (await get(`/exceptions?${win}&severity=CRITICAL&pageSize=100`).expect(200)).body.data
    expect(critical.items.every((i: { severity: string }) => i.severity === 'CRITICAL')).toBe(true); expect(critical.total).toBe(all.counts.CRITICAL)
    const mine = (await get(`/exceptions?${win}&hotelId=${hotels.charlie.id}`).expect(200)).body.data
    expect(mine.items.every((i: { hotelId: string }) => i.hotelId === hotels.charlie.id)).toBe(true)
    const p1 = (await get(`/exceptions?${win}&pageSize=3&page=1`).expect(200)).body.data; const p2 = (await get(`/exceptions?${win}&pageSize=3&page=2`).expect(200)).body.data
    expect(p1.items).toHaveLength(3); expect(p1.total).toBe(all.total); expect(p2.items.map((i: { id: string }) => i.id)).toEqual(all.items.slice(3, 6).map((i: { id: string }) => i.id))
    expect((await get(`/exceptions?${win}&supplierId=${supplierA}&pageSize=100`).expect(200)).body.data.total).toBeGreaterThan(0)
    await get('/exceptions?severity=SEVERE').expect(400); await get('/exceptions?category=NOPE').expect(400)
  })

  // ---- audit + bookings navigation -------------------------------------------------------------------------------------------
  it('HOTEL-OPS-20 / audit: hotel bookings are reachable by a server-side filter, and the hotel audit is sanitised and scoped', async () => {
    await prisma.booking.create({ data: { tenantId: tenantA, reference: `${suffix}-BK1`, supplier: 'contracted', hotelId: hotels.alpha.id, status: 'CONFIRMED', currency: 'AED', totalMinor: 90_000n, idempotencyKey: `${suffix}-bk1`, searchSnapshot: { checkIn: day(10), checkOut: day(12) } } })
    const d = await detail('alpha'); expect(d.counts.bookings).toBe(1)
    const bookings = (await get(`/bookings?hotelId=${hotels.alpha.id}`).expect(200)).body.data
    expect(bookings.total).toBe(1); expect(bookings.items[0]).toMatchObject({ hotelId: hotels.alpha.id, totalMinor: '90000', currency: 'AED' })
    expect((await get(`/bookings?hotelId=${hotels.bravo.id}`).expect(200)).body.data.total).toBe(0)
    await new AgentAuditService(new PrismaService()).record({ tenantId: tenantA, userId: (await prisma.user.findFirstOrThrow({ where: { email: `${suffix}-owner@example.test` } })).id, action: 'supply.hotel.updated', entityType: 'hotel', entityId: hotels.alpha.id, payload: { requestId: 'req-hc-1', email: 'secret@example.com', token: 'tok-123', note: 'kept' } })
    const audit = (await get(`/hotels/${hotels.alpha.id}/audit`).expect(200)).body.data
    expect(audit.total).toBeGreaterThanOrEqual(1)
    const event = audit.items.find((e: { action: string }) => e.action === 'supply.hotel.updated')
    expect(event).toMatchObject({ entityType: 'hotel', entityId: hotels.alpha.id, requestId: 'req-hc-1', actorType: 'USER' })
    expect(JSON.stringify(event)).not.toMatch(/secret@example|tok-123/); expect(event.payload.note).toBe('kept')
    expect((await get(`/hotels/${hotels.bravo.id}/audit`).expect(200)).body.data.items.every((e: { entityId: string }) => e.entityId !== hotels.alpha.id)).toBe(true)
  })

  // ---- security -------------------------------------------------------------------------------------------------------------
  it('HOTEL-OPS-16: tenant B sees none of tenant A: hotels, rooms, mappings, contracts, rates, availability, sellability, audit, exceptions', async () => {
    const own = (await get(`/hotels?${win}&pageSize=100`, 'bowner').expect(200)).body.data
    expect(own.items.map((h: { name: string }) => h.name)).toEqual([hotels.oscar.name]); expect(own.total).toBe(1)
    expect((await get(`/hotels/summary?${win}`, 'bowner').expect(200)).body.data.totalHotels).toBe(1)
    for (const path of ['', '/contracts', '/mappings', '/calendar', `/sellability?checkIn=${day(10)}&checkOut=${day(12)}&adults=2`, '/audit']) await get(`/hotels/${hotels.alpha.id}${path}`, 'bowner').expect(404)
    expect((await get(`/hotels?${win}&search=${encodeURIComponent(hotels.alpha.name)}`, 'bowner').expect(200)).body.data.total).toBe(0)
    expect((await get(`/exceptions?${win}&hotelId=${hotels.alpha.id}`, 'bowner').expect(200)).body.data.total).toBe(0)
    const ex = (await get(`/exceptions?${win}&pageSize=100`, 'bowner').expect(200)).body.data
    expect(ex.items.every((i: { hotelId: string }) => i.hotelId === hotels.oscar.id)).toBe(true)
    // a tenant id in the query string or a header for a tenant the caller does not belong to is ignored / refused
    expect((await get(`/hotels?${win}&tenantId=${tenantA}`, 'bowner').expect(200)).body.data.total).toBe(1)
    await request(app.getHttpServer()).get(`/api/v1/admin/operations/hotels?${win}`).set('Cookie', cookies.bowner).set('x-fbeds-tenant-id', tenantA).expect(403)
    // and the reverse
    await get(`/hotels/${hotels.oscar.id}`, 'owner').expect(404)
  })

  it('HOTEL-OPS-17: unauthenticated 401, no permission 403, authorised 200, per existing supply.* and audit.read keys', async () => {
    for (const path of ['/hotels', '/hotels/summary', `/hotels/${hotels.alpha.id}`, `/hotels/${hotels.alpha.id}/contracts`, `/hotels/${hotels.alpha.id}/calendar`, '/exceptions']) await get(path, 'anon').expect(401)
    await get('/hotels', 'none').expect(403); await get('/exceptions', 'none').expect(403)
    // viewer holds only supply.hotels.read
    await get('/hotels', 'viewer').expect(200); await get('/hotels/summary', 'viewer').expect(200); await get(`/hotels/${hotels.alpha.id}`, 'viewer').expect(200); await get('/exceptions', 'viewer').expect(200)
    await get(`/hotels/${hotels.alpha.id}/contracts`, 'viewer').expect(403)
    await get(`/hotels/${hotels.alpha.id}/mappings`, 'viewer').expect(403)
    await get(`/hotels/${hotels.alpha.id}/calendar`, 'viewer').expect(403)
    await get(`/hotels/${hotels.alpha.id}/sellability?checkIn=${day(10)}&checkOut=${day(12)}&adults=2`, 'viewer').expect(403)
    await get(`/hotels/${hotels.alpha.id}/audit`, 'viewer').expect(403)
    for (const path of [`/hotels/${hotels.alpha.id}/contracts`, `/hotels/${hotels.alpha.id}/mappings`, `/hotels/${hotels.alpha.id}/calendar`, `/hotels/${hotels.alpha.id}/audit`]) await get(path, 'owner').expect(200)
    const forbidden = await get('/hotels', 'none')
    expect(forbidden.body.success).toBe(false) // an error envelope, never an empty list
    expect(forbidden.body.data).toBeUndefined()
  })

  it('HOTEL-OPS-18: invalid input is a 400 and an unknown hotel a 404, never an empty result', async () => {
    for (const qs of ['page=abc', 'pageSize=0', 'from=2026-13-40', 'days=0', 'days=91', 'destination=%00', 'supplierId=a%20b', 'mapping=MAYBE', 'contractState=NOPE', 'contentStatus=nope']) await get(`/hotels?${qs}`).expect(400)
    await get('/hotels/does-not-exist').expect(404)
    await get('/hotels/..%2F..%2Fetc').expect(400)
  })

  it('HOTEL-OPS-RLS: under a non-bypass role, hotels, rooms, mappings, contracts, plans, rates and availability return only the current tenant', async () => {
    const raw = new PrismaClient()
    const tables = ['Hotel', 'RoomType', 'Supplier', 'SupplierHotelMapping', 'SupplierRoomMapping', 'Contract', 'RatePlan', 'DailyRate', 'DailyAvailability', 'BoardBasis']
    try {
      await raw.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_rls_test') THEN CREATE ROLE fbeds_rls_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;`)
      await raw.$executeRawUnsafe('GRANT fbeds_rls_test TO CURRENT_USER'); await raw.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fbeds_rls_test')
      await raw.$executeRawUnsafe(`GRANT SELECT ON TABLE ${tables.map((t) => `"${t}"`).join(', ')} TO fbeds_rls_test`)
      const asRole = <T,>(tenantId: string | null, work: (t: PrismaClient) => Promise<T>) => raw.$transaction(async (t) => {
        await t.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
        if (tenantId) await t.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
        const [who] = await t.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
        if (who.current_user !== 'fbeds_rls_test') throw new Error('not running as the restricted role')
        return work(t as unknown as PrismaClient)
      })
      const countIn = (tenantId: string | null, table: string) => asRole(tenantId, async (t) => (await t.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`))[0].n)
      expect(await countIn(tenantB, 'Hotel')).toBe(1)
      expect(await countIn(tenantB, 'Contract')).toBe(1)
      expect(await countIn(tenantB, 'RatePlan')).toBe(1)
      expect(await countIn(tenantB, 'SupplierHotelMapping')).toBe(1)
      expect(await countIn(tenantB, 'RoomType')).toBe(1)
      for (const table of tables) {
        expect({ table, none: await countIn(null, table) }).toEqual({ table, none: 0 }) // no tenant context: nothing
        const ids = await asRole(tenantB, async (t) => t.$queryRawUnsafe<Array<{ tenant_id?: string }>>(`SELECT * FROM "${table}"`))
        for (const row of ids) if ('tenant_id' in row) expect(row.tenant_id).toBe(tenantB)
      }
      const leaked = await asRole(tenantB, async (t) => (await t.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM "Hotel"')).map((r) => r.id))
      expect(leaked).not.toContain(hotels.alpha.id)
    } finally { await raw.$disconnect() }
  })

  it('HOTEL-OPS-21 performance: a 14-hotel list, summary and exceptions each run in a fixed number of queries (no per-hotel loops)', async () => {
    const queries: string[] = []
    const probe = new PrismaService({ log: [{ emit: 'event', level: 'query' }] } as never)
    ;(probe as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on('query', (q) => queries.push(q.query))
    const { OperationsHotelsService } = await import('../src/admin-operations/operations-hotels.service')
    const service = new OperationsHotelsService(probe)
    const measure = async (label: string, run: () => Promise<unknown>) => { queries.length = 0; await run(); return { label, selects: queries.filter((q) => /^SELECT/i.test(q)).length } }
    const small = [await measure('list', () => service.list(tenantA, { from: FROM, days: '5', pageSize: '100' })), await measure('summary', () => service.summary(tenantA, { from: FROM, days: '5' })), await measure('exceptions', () => service.exceptions(tenantA, { from: FROM, days: '5' }))]
    for (const m of small) expect({ ...m, bounded: m.selects <= 25 }).toEqual({ ...m, bounded: true })
    // the same call over 1 hotel and over 14 hotels uses the same number of statements: query count does not grow with hotels
    const one = await measure('one', () => service.list(tenantA, { from: FROM, days: '5', pageSize: '1' }))
    const many = await measure('many', () => service.list(tenantA, { from: FROM, days: '5', pageSize: '100' }))
    expect(many.selects).toBe(one.selects)
    await probe.$disconnect()
  })
})
