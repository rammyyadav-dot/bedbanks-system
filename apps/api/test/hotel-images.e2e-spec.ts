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

/** Hotel images (ADR 0027) over HTTP against PostgreSQL, two tenants. Image bytes are synthetic: only the header is read by the API. */
describe('hotel images (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `hi-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'hotel-images-password'
  let app: INestApplication
  let tenantA = '', tenantB = ''
  const hotels: Record<string, string> = {}
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}; const ids: Record<string, string> = {}
  let seq = 0

  const png = (w: number, h: number, seed = `${++seq}-${randomBytes(4).toString('hex')}`) => {
    const head = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head); head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1'); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20)
    return Buffer.concat([head, Buffer.from(seed)])
  }
  const jpeg = (w: number, h: number, seed = `${++seq}`) => {
    const frame = Buffer.alloc(19); frame[0] = 0xff; frame[1] = 0xc0; frame.writeUInt16BE(17, 2); frame[4] = 8; frame.writeUInt16BE(h, 5); frame.writeUInt16BE(w, 7)
    return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from(seed)])
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id); ids[label] = u.id
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
  const base = (hotel: string) => `/admin/hotels/${hotels[hotel] ?? hotel}/images`
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, who: string) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who])
  }
  const upload = (hotel: string, who: string, bytes: Buffer, type = 'image/png', alt: string | null = 'Pool at sunset') =>
    call('post', `${base(hotel)}${alt === null ? '' : `?altText=${encodeURIComponent(alt)}`}`, who).set('Content-Type', type).send(bytes)
  const list = async (hotel: string, who = 'manager') => (await call('get', base(hotel), who).expect(200)).body.data
  const newHotel = async (key: string, tenantId = tenantA) => { hotels[key] = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT' } })).id }

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const manager = await user('manager', tenantA, ['supply.hotels.read', 'supply.hotels.manage'])
    const reader = await user('reader', tenantA, ['supply.hotels.read']); const none = await user('none', tenantA, [])
    const bManager = await user('bmanager', tenantB, ['supply.hotels.read', 'supply.hotels.manage'])
    for (const k of ['main', 'other', 'race', 'limit', 'ops']) await newHotel(k)
    await newHotel('btenant', tenantB)
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ manager, reader, none, bmanager: bManager })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.hotelImage.deleteMany({ where: { tenantId } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
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

  it('HI-01 an image is stored, listed in order, served back byte for byte, and the first one is primary', async () => {
    const first = png(1600, 1200); const second = jpeg(1920, 1080)
    const a = (await upload('main', 'manager', first).expect(201)).body.data
    expect(a).toMatchObject({ contentType: 'image/png', width: 1600, height: 1200, altText: 'Pool at sunset', isPrimary: true, sortOrder: 0, bytes: first.length })
    const b = (await upload('main', 'manager', second, 'image/jpeg', '  Lobby  ').expect(201)).body.data
    expect(b).toMatchObject({ contentType: 'image/jpeg', altText: 'Lobby', isPrimary: false, sortOrder: 1 })
    const l = await list('main')
    expect(l.items.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]); expect(l.limits).toMatchObject({ maxPerHotel: 30, maxBytes: 5 * 1024 * 1024 })
    expect(JSON.stringify(l)).not.toMatch(/"data"/) // the bytes are never part of the list
    const served = await call('get', a.contentPath.replace('/api/v1', ''), 'reader').expect(200).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))) })
    expect(Buffer.compare(served.body as Buffer, first)).toBe(0)
    expect(served.headers['content-type']).toBe('image/png'); expect(served.headers['x-content-type-options']).toBe('nosniff'); expect(served.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hotels.main, action: 'hotel.image.uploaded' } })
    expect(events).toHaveLength(2); expect(events[0].userId).toBe(ids.manager)
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Pool at sunset|Lobby/) // alt text and file content never enter the audit
  })

  it('HI-02 only real JPEG, PNG and WebP within the limits are accepted, judged by the bytes and not the label', async () => {
    const before = (await list('other')).items.length
    const reject = async (p: request.Test, status: number, code?: string) => { const r = await p.expect(status); if (code) expect(r.body.error.code).toBe(code) }
    await reject(upload('other', 'manager', png(1600, 1200), 'image/jpeg'), 415, 'HOTEL_IMAGE_UNSUPPORTED_TYPE') // png bytes labelled jpeg
    await reject(upload('other', 'manager', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'), 415)
    await reject(upload('other', 'manager', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png'), 415) // svg labelled png
    await reject(upload('other', 'manager', Buffer.from('GIF89a' + 'x'.repeat(2000)), 'image/gif'), 415)
    await reject(upload('other', 'manager', Buffer.alloc(0), 'image/png'), 415)
    await reject(upload('other', 'manager', png(1600, 1200), 'application/json'), 415)
    await reject(upload('other', 'manager', png(1600, 1200), 'image/png', null), 400); await reject(upload('other', 'manager', png(1600, 1200), 'image/png', ''), 400); await reject(upload('other', 'manager', png(1600, 1200), 'image/png', 'x'.repeat(201)), 400)
    await reject(upload('other', 'manager', png(700, 500)), 422, 'HOTEL_IMAGE_BAD_DIMENSIONS'); await reject(upload('other', 'manager', png(9000, 1200)), 422, 'HOTEL_IMAGE_BAD_DIMENSIONS')
    await reject(upload('other', 'manager', Buffer.concat([png(1600, 1200), Buffer.alloc(5 * 1024 * 1024)])), 413, 'HOTEL_IMAGE_TOO_LARGE')
    expect((await list('other')).items.length).toBe(before) // nothing was stored by any refusal
    const same = png(1600, 1200, 'dup')
    const first = (await upload('other', 'manager', same).expect(201)).body.data
    const dup = await upload('other', 'manager', same).expect(409); expect(dup.body.error.code).toBe('HOTEL_IMAGE_DUPLICATE')
    expect((await list('other')).items).toHaveLength(1); expect(first.id).toBeTruthy()
  })

  it('HI-03 a hotel holds at most 30 images', async () => {
    await prisma.hotelImage.createMany({ data: Array.from({ length: 30 }, (_, i) => { const data = png(1600, 1200, `fill-${i}`); return { tenantId: tenantA, hotelId: hotels.limit, contentType: 'image/png', bytes: data.length, width: 1600, height: 1200, sha256: `${i}`.padStart(64, '0'), altText: `Image ${i}`, sortOrder: i, isPrimary: i === 0, data, uploadedById: ids.manager } }) })
    const r = await upload('limit', 'manager', png(1600, 1200, 'one-too-many')).expect(409)
    expect(r.body.error.code).toBe('HOTEL_IMAGE_LIMIT_REACHED'); expect((await list('limit')).items).toHaveLength(30)
  })

  it('HI-04 alt text, order and the primary image change by explicit edit, and there is always exactly one primary', async () => {
    await newHotel('edit')
    const made = [] as Array<{ id: string }>
    for (const i of [0, 1, 2]) made.push((await upload('edit', 'manager', png(1600, 1200, `e${i}`), 'image/png', `Image ${i}`).expect(201)).body.data)
    const [a, b, c] = made
    const path = (id: string) => `${base('edit')}/${id}`
    let l = (await call('patch', path(b.id), 'manager').send({ altText: '  Rooftop terrace ' }).expect(200)).body.data
    expect(l.items.find((i: { id: string }) => i.id === b.id).altText).toBe('Rooftop terrace')
    l = (await call('patch', path(c.id), 'manager').send({ sortOrder: 0 }).expect(200)).body.data // ties break by upload time
    expect(l.items.map((i: { id: string }) => i.id)).toEqual([a.id, c.id, b.id])
    l = (await call('patch', path(c.id), 'manager').send({ isPrimary: true }).expect(200)).body.data
    expect(l.items.filter((i: { isPrimary: boolean }) => i.isPrimary).map((i: { id: string }) => i.id)).toEqual([c.id])
    await call('patch', path(c.id), 'manager').send({ isPrimary: false }).expect(400) // a primary is replaced, not removed
    for (const bad of [{}, { name: 'x' }, { sortOrder: -1 }, { sortOrder: 1.5 }, { sortOrder: 5000 }, { altText: '' }, { altText: 'y'.repeat(201) }]) await call('patch', path(a.id), 'manager').send(bad).expect(400)
    await call('patch', `${base('main')}/${a.id}`, 'manager').send({ altText: 'Wrong hotel' }).expect(404) // an image is addressed through its own hotel
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hotels.edit, action: 'hotel.image.updated' } })
    expect(events.length).toBe(3); expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Rooftop/); expect(events[0].payload).toMatchObject({ fields: ['altText'] })
  })

  it('HI-05 deleting the primary promotes the next image; deleting twice is a 404; nothing else is touched', async () => {
    await newHotel('del')
    const ims = [] as Array<{ id: string }>
    for (const i of [0, 1]) ims.push((await upload('del', 'manager', png(1600, 1200, `d${i}`)).expect(201)).body.data)
    let l = (await call('delete', `${base('del')}/${ims[0].id}`, 'manager').expect(200)).body.data
    expect(l.items).toHaveLength(1); expect(l.items[0]).toMatchObject({ id: ims[1].id, isPrimary: true })
    await call('delete', `${base('del')}/${ims[0].id}`, 'manager').expect(404)
    l = (await call('delete', `${base('del')}/${ims[1].id}`, 'manager').expect(200)).body.data
    expect(l.items).toEqual([])
    const ev = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hotels.del, action: 'hotel.image.deleted' }, orderBy: { createdAt: 'asc' } })
    expect(ev[0].payload).toMatchObject({ wasPrimary: true, promotedImageId: ims[1].id })
  })

  it('HI-06 reads need hotels.read, writes need hotels.manage, and another tenant sees nothing', async () => {
    const [one] = (await list('main')).items
    await call('get', base('main'), 'none').expect(403); await call('get', base('main'), 'anon').expect(401)
    await upload('main', 'reader', png(1600, 1200)).expect(403); await upload('main', 'none', png(1600, 1200)).expect(403); await upload('main', 'anon', png(1600, 1200)).expect(401)
    await call('patch', `${base('main')}/${one.id}`, 'reader').send({ altText: 'x' }).expect(403); await call('delete', `${base('main')}/${one.id}`, 'reader').expect(403)
    expect((await call('get', one.contentPath.replace('/api/v1', ''), 'reader').expect(200)).headers['content-type']).toBe('image/png')
    await call('get', base('main'), 'bmanager').expect(404) // hotel of another tenant
    await upload('main', 'bmanager', png(1600, 1200)).expect(404)
    await call('get', `${base('btenant')}/${one.id}/content`, 'bmanager').expect(404) // image id of tenant A under tenant B's own hotel
    await call('get', `/admin/hotels/does-not-exist/images`, 'manager').expect(404)
    expect(await prisma.hotelImage.count({ where: { tenantId: tenantB } })).toBe(0)
  })

  it('HI-08 the whole order is set atomically, and a stale or partial list changes nothing', async () => {
    await newHotel('order')
    const made = [] as Array<{ id: string }>
    for (const i of [0, 1, 2]) made.push((await upload('order', 'manager', png(1600, 1200, `o${i}`)).expect(201)).body.data)
    const [a, b, c] = made.map((m) => m.id)
    const put = (who: string, body: object, hotel = 'order') => call('put', `${base(hotel)}/order`, who).send(body)
    const l = (await put('manager', { imageIds: [c, a, b] }).expect(200)).body.data
    expect(l.items.map((i: { id: string; sortOrder: number }) => [i.id, i.sortOrder])).toEqual([[c, 0], [a, 1], [b, 2]])
    expect(l.items.find((i: { isPrimary: boolean }) => i.isPrimary).id).toBe(a) // order does not change which image is primary
    for (const bad of [{}, { imageIds: [] }, { imageIds: 'x' }, { imageIds: [a, b] }, { imageIds: [a, a, b] }, { imageIds: [a, b, c, c] }, { imageIds: [a, b, 'not-mine'] }, { imageIds: [a, b, 42] }]) {
      const r = await put('manager', bad); expect([400, 409]).toContain(r.status)
    }
    expect((await put('manager', { imageIds: [a, b] }).expect(409)).body.error.code).toBe('HOTEL_IMAGE_ORDER_MISMATCH')
    expect((await list('order')).items.map((i: { id: string }) => i.id)).toEqual([c, a, b]) // unchanged by every refusal
    await put('reader', { imageIds: [a, b, c] }).expect(403); await put('anon', { imageIds: [a, b, c] }).expect(401); await put('bmanager', { imageIds: [a, b, c] }).expect(404)
    const other = (await upload('main', 'manager', png(1600, 1200, 'other-hotel')).expect(201)).body.data.id
    expect((await put('manager', { imageIds: [a, b, other] }).expect(409)).body.error.code).toBe('HOTEL_IMAGE_ORDER_MISMATCH') // another hotel's image cannot be slipped in
    const ev = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hotels.order, action: 'hotel.image.reordered' } })
    expect(ev).toHaveLength(1); expect(ev[0].payload).toMatchObject({ count: 3 })
  })

  it('HI-07 concurrent uploads keep one primary, distinct positions and an exact count', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => upload('race', 'manager', png(1600, 1200, `race-${i}`), 'image/png', `Race ${i}`)))
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201])
    const l = await list('race')
    expect(l.items).toHaveLength(6); expect(l.items.filter((i: { isPrimary: boolean }) => i.isPrimary)).toHaveLength(1)
    expect(new Set(l.items.map((i: { sortOrder: number }) => i.sortOrder)).size).toBe(6)
  })
})
