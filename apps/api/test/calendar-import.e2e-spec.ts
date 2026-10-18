import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { setContractStatusFixture } from './contract-status-fixture'

/**
 * ADR 0041: rate plan lifecycle status is written only by the readiness-gated activate/suspend routes. Everything here runs
 * through the real HTTP API against a disposable PostgreSQL; the owner Prisma client is used only to arrange and to observe.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Calendar CSV import (ADR 0057, S7)', () => {
  const suffix = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'lifecycle-certification-password'
  const nights = Array.from({ length: 5 }, (_, offset) => iso(14 + offset))
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let operator: string, readOnly: string, outsider: string
  const userIds: string[] = []
  const roleIds: string[] = []
  let supplierId: string, hotelId: string, roomId: string, boardId: string, mappingId: string, contractId: string
  let n = 0

  const api = (cookie: string, tenant = tenantId) => {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => configure(request(app.getHttpServer()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => configure(request(app.getHttpServer()).patch(`/api/v1${path}`)).send(body),
    }
  }
  const login = async (email: string) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  /** A DRAFT plan, optionally complete with rates and availability for the five test nights. */
  const newPlan = async (complete: boolean, body: Record<string, unknown> = {}) => {
    const plan = await api(operator).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-P${++n}`, occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0, ...body }).expect(201)
    const id = plan.body.data.id as string
    if (complete) {
      await api(operator).post('/supply/daily-rates/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: id, stayDate, occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' })) }).expect(201)
      await api(operator).post('/supply/availability/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: id, stayDate, allotment: 5, sold: 0, stopSell: false, minStay: 1 })) }).expect(201)
    }
    return id
  }
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }
  const row = (id: string) => prisma.ratePlan.findUniqueOrThrow({ where: { id } })

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['operator', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    const keys = ['hotels', 'rooms', 'rates', 'contracts', 'availability', 'suppliers', 'mappings'].flatMap((area) => [`supply.${area}.read`, `supply.${area}.manage`])
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (tenant: string, name: string, granted: typeof permissions) => {
      const role = await prisma.role.create({ data: { tenantId: tenant, name: `${suffix}-${name}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      return role.id
    }
    const operatorRole = await grant(tenantId, 'operator', permissions)
    const readOnlyRole = await grant(tenantId, 'readonly', permissions.filter((permission) => permission.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'member' }, { tenantId: otherTenantId, userId: userIds[2], role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: operatorRole }, { tenantId, userId: userIds[1], roleId: readOnlyRole }, { tenantId: otherTenantId, userId: userIds[2], roleId: outsiderRole }] })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    operator = await login(`${suffix}-operator@example.test`)
    readOnly = await login(`${suffix}-readonly@example.test`)
    outsider = await login(`${suffix}-outsider@example.test`)

    supplierId = (await api(operator).post('/supply/suppliers', { type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Supplier LLC`, displayName: 'Lifecycle Supplier', countryCode: 'AE', defaultCurrency: 'AED' }).expect(201)).body.data.id
    hotelId = (await api(operator).post('/supply/hotels', { name: `${suffix} Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', starRating: 4 }).expect(201)).body.data.id
    roomId = (await api(operator).post(`/supply/hotels/${hotelId}/rooms`, { name: 'Deluxe King', code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }).expect(201)).body.data.id
    boardId = (await api(operator).post('/supply/board-bases', { code: 'BB', name: 'Bed & Breakfast' }).expect(201)).body.data.id
    mappingId = (await api(operator).post('/supply/mappings/hotels', { supplierId, hotelId, supplierHotelId: `${suffix}-SUP` }).expect(201)).body.data.id
    const roomMapping = (await api(operator).post(`/supply/mappings/hotels/${mappingId}/rooms`, { supplierRoomId: `${suffix}-DLX`, roomTypeId: roomId }).expect(201)).body.data.id
    await api(operator).post(`/supply/mappings/hotels/${mappingId}/approve`).expect(201)
    await api(operator).post(`/supply/mappings/hotels/${mappingId}/rooms/${roomMapping}/approve`).expect(201)
    contractId = (await api(operator).post('/supply/contracts', { supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-C1`, validFrom: iso(-30), validTo: iso(365), settlementCurrency: 'AED', salesMarkets: ['AE'], nationalities: [] }).expect(201)).body.data.id
    await api(operator).post(`/supply/contracts/${contractId}/policies/cancellation`, { daysBeforeCheckin: 7, penaltyPercent: 100 }).expect(201)
    await setContractStatusFixture(prisma, contractId, 'ACTIVE')
  }, 90000)

  afterAll(async () => {
    await app?.close()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.dailyRate.deleteMany({ where: { tenantId: tenants } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
    await prisma.contract.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: tenants } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: tenants } } })
    await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: tenants } })
    await prisma.$disconnect()
  })


  const importCsv = (cookie: string, csv: string, hotel = hotelId, tenant = tenantId) => api(cookie, tenant).post('/supply/calendar/import/preview', { hotelId: hotel, csv })
  const rateCount = (planId: string) => prisma.dailyRate.count({ where: { ratePlanId: planId } })
  const H = 'plan_code,date,amount,basis'
  let planId: string, planCode: string
  const d = (offset: number) => iso(offset)

  beforeAll(async () => {
    planId = await newPlan(false, { refundable: true })
    planCode = (await row(planId)).code
  })

  describe('preview', () => {
    it('validates a file and returns an ordinary calendar edit plus the standard preview, writing nothing', async () => {
      const csv = [H, `${planCode},${d(20)},450.50,SELL`, `${planCode},${d(21)},460,SELL`, `${planCode},${d(22)},470,NET`].join('\n')
      const r = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
      expect(r).toMatchObject({ ok: true, fatal: [], errors: [], stats: { dataRows: 3, acceptedRows: 3, rejectedRows: 0 } })
      expect(r.edit.rates).toEqual([
        expect.objectContaining({ ratePlanId: planId, stayDate: d(20), amountMinor: '45050', amountBasis: 'SELL', currency: 'AED', expectedUpdatedAt: null }),
        expect.objectContaining({ stayDate: d(21), amountMinor: '46000' }), expect.objectContaining({ stayDate: d(22), amountMinor: '47000', amountBasis: 'NET' }),
      ])
      expect(r.preview).toMatchObject({ affectedCells: 3 })
      expect(await rateCount(planId)).toBe(0)
    })
    it('applies exactly the reviewed edit through the existing apply route, in integer minor units, with audit', async () => {
      const csv = [H, `${planCode},${d(30)},123.45,SELL`, `${planCode},${d(31)},200,SELL`].join('\n')
      const preview = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
      await api(operator).post('/supply/calendar/apply', preview.edit).then((x) => expectStatus(x, 201))
      const saved = await prisma.dailyRate.findMany({ where: { ratePlanId: planId, stayDate: { in: [new Date(d(30)), new Date(d(31))] } }, orderBy: { stayDate: 'asc' } })
      expect(saved.map((s) => [s.amountMinor, s.amountBasis, s.currency])).toEqual([[12345n, 'SELL', 'AED'], [20000n, 'SELL', 'AED']])
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'supply.daily_rate.updated', entityId: { in: saved.map((s) => s.id) } } })).toBe(2)
    })
    it('re-importing shows the existing value as "before" and carries the cell version', async () => {
      const r = (await importCsv(operator, [H, `${planCode},${d(30)},130,SELL`].join('\n')).then((x) => expectStatus(x, 201))).body.data
      expect(r.edit.rates[0].expectedUpdatedAt).toEqual(expect.any(String))
      expect(r.preview.changes[0]).toMatchObject({ kind: 'rate', before: { amountMinor: '12345', amountBasis: 'SELL', currency: 'AED' }, after: expect.objectContaining({ amountMinor: '13000' }) })
    })
  })

  it('imports a period release per night, then clears it back to the plan release (ADR 0067, F-08)', async () => {
    const csv = ['plan_code,date,allotment,release_days', `${planCode},${d(50)},4,14`, `${planCode},${d(51)},4,`].join('\n')
    const preview = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
    expect(preview.edit.availability.map((c: { releaseDays: number | null }) => c.releaseDays)).toEqual([14, null])
    await api(operator).post('/supply/calendar/apply', preview.edit).then((x) => expectStatus(x, 201))
    const night = () => prisma.dailyAvailability.findUniqueOrThrow({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: new Date(d(50)) } } })
    expect((await night()).releaseDays).toBe(14)
    const cleared = (await importCsv(operator, ['plan_code,date,release_days', `${planCode},${d(50)},plan`].join('\n')).then((x) => expectStatus(x, 201))).body.data
    expect(cleared.preview.changes[0]).toMatchObject({ before: { releaseDays: 14 }, after: { releaseDays: null } })
    await api(operator).post('/supply/calendar/apply', cleared.edit).then((x) => expectStatus(x, 201))
    expect((await night()).releaseDays).toBeNull()
  })

  describe('row-level errors and the error file', () => {
    it('keeps the good rows, reports each bad row with its line and reason, and applies only what was accepted', async () => {
      const before = await rateCount(planId)
      const csv = [H, `${planCode},${d(40)},500,SELL`, `${planCode},not-a-date,500,SELL`, `NOPE,${d(41)},500,SELL`, `${planCode},${d(42)},5,00,SELL`.replace('5,00', '"5,00"'), `${planCode},${d(43)},510,SELL`].join('\n')
      const r = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
      expect(r.ok).toBe(false)
      expect(r.errors.map((e: { line: number; code: string }) => [e.line, e.code])).toEqual([[3, 'DATE_INVALID'], [4, 'PLAN_NOT_FOUND'], [5, 'AMOUNT_INVALID']])
      expect(r.stats).toMatchObject({ dataRows: 5, acceptedRows: 2, rejectedRows: 3 })
      expect(r.edit.rates.map((c: { stayDate: string }) => c.stayDate)).toEqual([d(40), d(43)])
      await api(operator).post('/supply/calendar/apply', r.edit).then((x) => expectStatus(x, 201))
      expect(await rateCount(planId)).toBe(before + 2)
    })
    it('conflicting duplicates are rejected, identical ones collapse, and unknown columns refuse the whole file', async () => {
      const csv = [H, `${planCode},${d(50)},500,SELL`, `${planCode},${d(50)},510,SELL`, `${planCode},${d(51)},500,SELL`, `${planCode},${d(51)},500,SELL`].join('\n')
      const r = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
      expect(r.errors.map((e: { code: string }) => e.code)).toEqual(['DUPLICATE_CONFLICT', 'DUPLICATE_CONFLICT'])
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'DUPLICATE_IDENTICAL' })])
      expect(r.edit.rates.map((c: { stayDate: string }) => c.stayDate)).toEqual([d(51)])
      const fatal = (await importCsv(operator, `${H},price\n${planCode},${d(52)},500,SELL,1`).then((x) => expectStatus(x, 201))).body.data
      expect(fatal).toMatchObject({ ok: false, edit: null, preview: null })
      expect(fatal.fatal[0].code).toBe('UNKNOWN_COLUMN')
    })
    it('a file over the size limit is refused with a typed reason and produces no cells', async () => {
      const line = `${planCode},${d(60)},500,SELL`
      const big = [H, ...Array.from({ length: Math.ceil(92_000 / (line.length + 1)) }, () => line)].join('\n')
      expect(big.length).toBeGreaterThan(90_000)
      expect(big.length).toBeLessThan(100_000)
      const r = (await importCsv(operator, big).then((x) => expectStatus(x, 201))).body.data
      expect(r.fatal[0].code).toBe('FILE_TOO_LARGE')
      expect(r.edit).toBeNull()
    })
    it('an expired plan is refused row by row', async () => {
      const expired = await newPlan(false, {})
      await prisma.ratePlan.update({ where: { id: expired }, data: { status: 'EXPIRED' } })
      const code = (await row(expired)).code
      const r = (await importCsv(operator, [H, `${code},${d(70)},500,SELL`].join('\n')).then((x) => expectStatus(x, 201))).body.data
      expect(r.errors[0]).toMatchObject({ code: 'PLAN_EXPIRED' })
    })
  })

  describe('availability', () => {
    it('writes allotment, stop sell and minimum stay, and refuses an allotment below what is sold or held', async () => {
      const csv = ['plan_code,date,allotment,stop_sell,min_stay', `${planCode},${d(80)},6,false,2`, `${planCode},${d(81)},4,true,`].join('\n')
      const first = (await importCsv(operator, csv).then((x) => expectStatus(x, 201))).body.data
      expect(first.errors).toEqual([])
      await api(operator).post('/supply/calendar/apply', first.edit).then((x) => expectStatus(x, 201))
      const cell = await prisma.dailyAvailability.findFirstOrThrow({ where: { ratePlanId: planId, stayDate: new Date(d(80)) } })
      expect(cell).toMatchObject({ allotment: 6, stopSell: false, minStay: 2 })
      await prisma.dailyAvailability.update({ where: { id: cell.id }, data: { sold: 4, held: 1 } })
      const low = (await importCsv(operator, ['plan_code,date,allotment', `${planCode},${d(80)},4`].join('\n')).then((x) => expectStatus(x, 201))).body.data
      expect(low.errors[0]).toMatchObject({ code: 'ALLOTMENT_BELOW_COMMITTED' })
      const keep = (await importCsv(operator, ['plan_code,date,stop_sell', `${planCode},${d(80)},true`].join('\n')).then((x) => expectStatus(x, 201))).body.data
      expect(keep.edit.availability[0]).toMatchObject({ allotment: 6, stopSell: true, minStay: 2 }) // omitted fields keep their current values
    })
  })

  describe('safety', () => {
    it('a stale review is refused per cell and nothing is applied', async () => {
      const preview = (await importCsv(operator, [H, `${planCode},${d(90)},500,SELL`].join('\n')).then((x) => expectStatus(x, 201))).body.data
      await api(operator).post('/supply/daily-rates/bulk', { rows: [{ ratePlanId: planId, stayDate: d(90), occupancy: 2, amountMinor: '99900', amountBasis: 'SELL', currency: 'AED' }] }).expect(201)
      const refused = await api(operator).post('/supply/calendar/apply', preview.edit).then((x) => expectStatus(x, 409))
      expect(refused.body.error.code).toBe('CALENDAR_CHANGED')
      expect((await prisma.dailyRate.findFirstOrThrow({ where: { ratePlanId: planId, stayDate: new Date(d(90)) } })).amountMinor).toBe(99900n)
    })
    it('a read-only user is refused (403) and the denial is audited; another tenant gets 404 and sees none of this hotel\'s plans', async () => {
      const csv = [H, `${planCode},${d(95)},500,SELL`].join('\n')
      await importCsv(readOnly, csv).then((x) => expectStatus(x, 403))
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'permission.denied' } })).toBeGreaterThan(0)
      await importCsv(outsider, csv, hotelId, otherTenantId).then((x) => expectStatus(x, 404))
      await importCsv(operator, csv, 'does-not-exist').then((x) => expectStatus(x, 404))
    })
    it('a missing hotel, a non-text file and an unauthenticated call are refused', async () => {
      await api(operator).post('/supply/calendar/import/preview', { csv: H }).then((x) => expectStatus(x, 400))
      await api(operator).post('/supply/calendar/import/preview', { hotelId, csv: 5 }).then((x) => expectStatus(x, 400))
      await request(app.getHttpServer()).post('/api/v1/supply/calendar/import/preview').send({ hotelId, csv: H }).then((x) => expectStatus(x, 401))
    })
  })
})
