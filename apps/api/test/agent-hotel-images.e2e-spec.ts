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

jest.setTimeout(180_000)

/** Agents see the primary image of PUBLISHED hotels only (ADR 0027), over HTTP against PostgreSQL, two tenants. */
describe('agent hotel images (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `ai-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'agent-hotel-images-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (o: number) => new Date(midnight + o * 86_400_000).toISOString().slice(0, 10)
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierId = '', hotelId = '', draftId = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  let seq = 0

  const png = (w: number, h: number, seed: string) => {
    const head = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head); head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1'); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20)
    return Buffer.concat([head, Buffer.from(seed)])
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const k of keys) {
        const p = await prisma.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })
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
  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, who: string) => request(app.getHttpServer())[method](`/api/v1${path}`).set('Cookie', cookies[who])
  const search = (who: string) => call('post', '/agent/search', who).send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  const hotelsOf = async (who: string) => (await search(who).expect(201)).body.data.hotels as Array<{ hotelId: string; primaryImage?: { imageId: string; altText: string; width: number; height: number } }>
  const upload = (id: string, bytes: Buffer, alt: string) => call('post', `/admin/hotels/${id}/images?altText=${encodeURIComponent(alt)}`, 'manager').set('Content-Type', 'image/png').send(bytes)

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} S`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    const boardBasisId = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Published`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    draftId = (await prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Draft`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT', starRating: 4 } })).id
    const room = await prisma.roomType.create({ data: { hotelId, name: 'Deluxe', code: 'D1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-sh`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-sr`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: suffix, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(400), settlementCurrency: 'AED' } as never })
    const plan = await prisma.ratePlan.create({ data: { tenantId: tenantA, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: 'BB1', status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 30 }, (_, i) => utc(i))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 10_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    const manager = await user('manager', tenantA, ['supply.hotels.read', 'supply.hotels.manage'])
    const agent = await user('agent', tenantA, ['hotel.search']); const noperm = await user('noperm', tenantA, [])
    const bAgent = await user('bagent', tenantB, ['hotel.search'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ manager, agent, noperm, bagent: bAgent })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.hotelImage.deleteMany({ where: { tenantId } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
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

  it('AI-01 a published hotel without images is returned without an image field, never a placeholder', async () => {
    const hotels = await hotelsOf('agent')
    const mine = hotels.find((h) => h.hotelId === hotelId)
    expect(mine).toBeTruthy(); expect(mine).not.toHaveProperty('primaryImage')
  })

  it('AI-02 the primary image appears in search, with a reference and no URL, and the bytes are served to the Agent', async () => {
    const first = png(1600, 1200, `a-${++seq}`); const second = png(1200, 800, `b-${++seq}`)
    const a = (await upload(hotelId, first, 'Pool at sunset').expect(201)).body.data
    await upload(hotelId, second, 'Lobby').expect(201)
    const mine = (await hotelsOf('agent')).find((h) => h.hotelId === hotelId)!
    expect(mine.primaryImage).toEqual({ imageId: a.id, altText: 'Pool at sunset', width: 1600, height: 1200 }) // the primary, not the newest
    expect(JSON.stringify(mine.primaryImage)).not.toMatch(/http|data:/)
    const served = await call('get', `/agent/hotels/${hotelId}/images/${a.id}/content`, 'agent').expect(200).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))) })
    expect(Buffer.compare(served.body as Buffer, first)).toBe(0); expect(served.headers['content-type']).toBe('image/png'); expect(served.headers['x-content-type-options']).toBe('nosniff')
    // changing the primary changes what Agents see
    const list = (await call('get', `/admin/hotels/${hotelId}/images`, 'manager').expect(200)).body.data.items as Array<{ id: string; altText: string }>
    const lobby = list.find((i) => i.altText === 'Lobby')!
    await call('patch', `/admin/hotels/${hotelId}/images/${lobby.id}`, 'manager').send({ isPrimary: true }).expect(200)
    expect((await hotelsOf('agent')).find((h) => h.hotelId === hotelId)!.primaryImage).toMatchObject({ imageId: lobby.id, altText: 'Lobby' })
  })

  it('AI-03 an image route serves only published hotels of the caller tenant to callers who may search', async () => {
    const img = (await prisma.hotelImage.findFirstOrThrow({ where: { hotelId, tenantId: tenantA } })).id
    await call('get', `/agent/hotels/${hotelId}/images/${img}/content`, 'noperm').expect(403)
    await call('get', `/agent/hotels/${hotelId}/images/${img}/content`, 'bagent').expect(404) // another tenant's hotel
    const draftImage = png(1600, 1200, `draft-${++seq}`)
    const d = (await upload(draftId, draftImage, 'Draft room').expect(201)).body.data
    await call('get', `/agent/hotels/${draftId}/images/${d.id}/content`, 'agent').expect(404) // a draft is not visible to Agents
    await call('get', `/agent/hotels/${hotelId}/images/${d.id}/content`, 'agent').expect(404) // an image is addressed through its own hotel
    await call('get', `/agent/hotels/${hotelId}/images/does-not-exist/content`, 'agent').expect(404)
    await prisma.hotel.update({ where: { id: hotelId }, data: { contentStatus: 'SUSPENDED' } })
    await call('get', `/agent/hotels/${hotelId}/images/${img}/content`, 'agent').expect(404) // withdrawing the hotel withdraws its images
    await prisma.hotel.update({ where: { id: hotelId }, data: { contentStatus: 'COMPLETE' } })
    await call('get', `/agent/hotels/${hotelId}/images/${img}/content`, 'agent').expect(200)
  })

  it('AI-04 deleting the images removes the field again', async () => {
    const list = (await call('get', `/admin/hotels/${hotelId}/images`, 'manager').expect(200)).body.data.items as Array<{ id: string }>
    for (const i of list) await call('delete', `/admin/hotels/${hotelId}/images/${i.id}`, 'manager').expect(200)
    expect((await hotelsOf('agent')).find((h) => h.hotelId === hotelId)).not.toHaveProperty('primaryImage')
  })
})
