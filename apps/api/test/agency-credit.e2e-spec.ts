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
import { InventoryHoldService } from '../src/agent/inventory-hold.service'

jest.setTimeout(180_000)

/** Agency credit limit (ADR 0024) over HTTP against PostgreSQL: maker-checker changes, enforcement when a hold is placed, tenant isolation. */
describe('agency credit limit (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const holdDb = new PrismaService()
  const holds = new InventoryHoldService(holdDb)
  const suffix = `cr-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'credit-limit-password'
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierId = '', hotelId = '', roomId = '', boardId = '', ratePlanId = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}; const ids: Record<string, string> = {}
  let seq = 0
  const key = () => `${suffix}-k${++seq}-${randomBytes(2).toString('hex')}`
  const ALL = ['agency.read', 'agency.manage']
  const checkIn = '2099-03-01'; const checkOut = '2099-03-02'

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
  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`); const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c
  }
  const base = '/admin/clients/agencies'
  const newAgency = async (members: string[]) => {
    const a = (await api('post', base, 'admin', { code: `CR-${++seq}-${suffix.slice(-4).toUpperCase()}`, name: `Credit ${seq}` }).expect(201)).body.data
    for (const m of members) await api('post', `${base}/${a.id}/members`, 'admin', { userId: ids[m] }).expect(200)
    return a.id as string
  }
  const ask = (agencyId: string, who: string, body: object) => api('post', `${base}/${agencyId}/request-credit-limit`, who, { requestId: key(), reason: 'Agreed with finance', ...body })
  const credit = async (agencyId: string, who = 'admin') => (await api('get', `${base}/${agencyId}`, who).expect(200)).body.data.credit
  /** Request by admin, approve by checker, apply by admin. */
  const setLimit = async (agencyId: string, body: { currency?: string; limitMinor: string | null }) => {
    const made = (await ask(agencyId, 'admin', body).expect(200)).body.data.credit.open
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
    return (await api('post', `${base}/credit-approvals/${made.id}/execute`, 'admin', {}).expect(200)).body.data
  }
  let holdSeq = 0
  const hold = (who: string, amount: number, currency = 'AED', idem = `${suffix}-h${++holdSeq}`) => holds.create({
    tenantId: tenantA, userId: ids[who], requestId: `${idem}-req`, idempotencyKey: idem, offerId: 'offer', searchId: 'search', ratePlanId, canonicalHotelId: hotelId,
    canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn, checkOut, rooms: 1, currency, sellAmountMinor: amount, offerExpiresAt: '2099-03-01T12:00:00.000Z',
  })
  const refusal = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return (e as { getResponse?: () => { code?: string; details?: { availableMinor?: string } } }).getResponse?.() ?? { code: 'OTHER' } } }

  beforeAll(async () => {
    await prisma.$connect(); await holdDb.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} S`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Room', code: 'R1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })).id
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-sh`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-sr`, roomTypeId: roomId, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } as never })
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId: tenantA, contractId: contract.id, roomTypeId: roomId, boardBasisId: boardId, code: suffix.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.create({ data: { tenantId: tenantA, ratePlanId, stayDate: new Date(checkIn), allotment: 200 } })
    const admin = await user('admin', tenantA, ALL); const checker = await user('checker', tenantA, ALL)
    const reader = await user('reader', tenantA, ['agency.read']); const none = await user('none', tenantA, [])
    await user('agentin', tenantA, ['hotel.search']); await user('agentin2', tenantA, ['hotel.search']); await user('agentin3', tenantA, ['hotel.search']); await user('agentout', tenantA, ['hotel.search'])
    const bAdmin = await user('badmin', tenantB, ALL)
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ admin, checker, reader, none, badmin: bAdmin })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.approvalRequest.deleteMany({ where: { tenantId } })
      await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
      await prisma.inventoryHold.deleteMany({ where: { tenantId } })
      await prisma.agencyMember.deleteMany({ where: { tenantId } })
      await prisma.agency.deleteMany({ where: { tenantId } })
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
    await holdDb.$disconnect(); await prisma.$disconnect()
  })

  it('CR-01 a limit is set by request, a different approver and a single apply, and the position is read back', async () => {
    const a = await newAgency([])
    expect(await credit(a)).toEqual({ limit: null, committedMinor: null, availableMinor: null, open: null }) // nothing configured, nothing enforced
    const made = (await ask(a, 'admin', { currency: 'AED', limitMinor: '100000' }).expect(200)).body.data.credit.open
    expect(made).toMatchObject({ status: 'PENDING', currency: 'AED', limitMinor: '100000', previousLimitMinor: null, canDecide: false, canCancel: true })
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'admin', { reason: 'Self' }).expect(403)
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'reader', { reason: 'No' }).expect(403)
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'badmin', { reason: 'Other tenant' }).expect(404)
    await api('post', `${base}/credit-approvals/${made.id}/execute`, 'admin', {}).expect(409) // not approved
    expect((await credit(a)).limit).toBeNull()
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
    const done = (await api('post', `${base}/credit-approvals/${made.id}/execute`, 'admin', {}).expect(200)).body.data
    expect(done.approval.status).toBe('EXECUTED')
    expect(done.agency.credit).toEqual({ limit: { currency: 'AED', limitMinor: '100000' }, committedMinor: '0', availableMinor: '100000', open: null })
    await api('post', `${base}/credit-approvals/${made.id}/execute`, 'admin', {}).expect(409) // single use
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: 'agency.credit_limit.changed', entityId: a } })
    expect(events).toHaveLength(1); expect(events[0].userId).toBe(ids.admin)
    expect(events[0].payload).toMatchObject({ approvalId: made.id, currency: 'AED', limitMinor: '100000', previousLimitMinor: null })
    expect(JSON.stringify(events[0].payload)).not.toContain('Agreed with finance') // the reason lives in the approval, not the audit payload
  })

  it('CR-02 requests are validated, tenant-scoped and permissioned; one open request; no-ops are refused', async () => {
    const a = await newAgency([])
    for (const bad of [{ limitMinor: '10.5', currency: 'AED' }, { limitMinor: '-1', currency: 'AED' }, { limitMinor: '007', currency: 'AED' }, { limitMinor: 1000, currency: 'AED' }, { limitMinor: '1'.repeat(19), currency: 'AED' }, { limitMinor: '1000', currency: 'aed' }, { limitMinor: '1000' }, {}]) {
      await ask(a, 'admin', bad).expect(400)
    }
    await ask(a, 'admin', { limitMinor: null }).expect(409) // nothing to remove
    await ask(a, 'reader', { limitMinor: '1000', currency: 'AED' }).expect(403); await ask(a, 'none', { limitMinor: '1000', currency: 'AED' }).expect(403); await ask(a, 'anon', { limitMinor: '1000', currency: 'AED' }).expect(401)
    await ask(a, 'badmin', { limitMinor: '1000', currency: 'AED' }).expect(404)
    const first = (await ask(a, 'admin', { limitMinor: '1000', currency: 'AED' }).expect(200)).body.data.credit.open
    expect((await ask(a, 'admin', { limitMinor: '2000', currency: 'AED' }).expect(409)).body.error.code).toBe('AGENCY_CREDIT_REQUEST_OPEN')
    await api('post', `${base}/credit-approvals/${first.id}/cancel`, 'checker', {}).expect(403) // only the maker withdraws
    await api('post', `${base}/credit-approvals/${first.id}/cancel`, 'admin', {}).expect(200)
    await api('post', `${base}/credit-approvals/${first.id}/reject`, 'checker', { reason: 'late' }).expect(409)
    const again = await setLimit(a, { currency: 'AED', limitMinor: '5000' })
    expect(again.agency.credit.limit).toEqual({ currency: 'AED', limitMinor: '5000' })
    await ask(a, 'admin', { limitMinor: '5000', currency: 'AED' }).expect(409) // same limit again
    // a change made after the request but before apply voids it
    const made = (await ask(a, 'admin', { limitMinor: '9000', currency: 'AED' }).expect(200)).body.data.credit.open
    await api('post', `${base}/credit-approvals/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
    await prisma.agencyCreditLimit.update({ where: { agencyId: a }, data: { limitMinor: 7000n } })
    expect((await api('post', `${base}/credit-approvals/${made.id}/execute`, 'admin', {}).expect(409)).body.error.code).toBe('AGENCY_CREDIT_CHANGED_AFTER_REQUEST')
    expect((await credit(a)).limit.limitMinor).toBe('7000')
  })

  it('CR-03 a hold is refused over the limit, allowed at it, and everything else is unaffected', async () => {
    const a = await newAgency(['agentin', 'agentin2'])
    await setLimit(a, { currency: 'AED', limitMinor: '100000' })
    await hold('agentin', 60000)
    expect((await credit(a)).committedMinor).toBe('60000')
    const over = await refusal(hold('agentin2', 50000)) // a different member of the same agency counts toward the same limit
    expect(over).toMatchObject({ code: 'AGENCY_CREDIT_LIMIT_EXCEEDED', details: { availableMinor: '40000' } })
    expect(await prisma.inventoryHold.count({ where: { tenantId: tenantA, createdByUserId: ids.agentin2 } })).toBe(0) // nothing was written
    const exact = await hold('agentin2', 40000) // exactly at the limit is allowed
    expect(await credit(a)).toMatchObject({ committedMinor: '100000', availableMinor: '0' })
    await expect(hold('agentin', 1)).rejects.toMatchObject({ status: 403 })
    // an idempotent replay returns the stored hold even when the agency is now at its limit
    const replay = await holds.create({ tenantId: tenantA, userId: ids.agentin2, requestId: 'x-req', idempotencyKey: (await prisma.inventoryHold.findFirstOrThrow({ where: { id: exact.holdId } })).idempotencyKey, offerId: 'offer', searchId: 'search', ratePlanId, canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn, checkOut, rooms: 1, currency: 'AED', sellAmountMinor: 40000, offerExpiresAt: '2099-03-01T12:00:00.000Z' })
    expect(replay.status).toBe('already_held')
    // another currency is refused, not converted
    expect(await refusal(hold('agentin', 1, 'USD'))).toMatchObject({ code: 'AGENCY_CREDIT_CURRENCY_MISMATCH' })
    // a user in no agency, and an agency with no limit, are not limited
    await hold('agentout', 9_000_000)
    const free = await newAgency([]); expect((await credit(free)).limit).toBeNull()
    // releasing a hold frees its credit; an expired HELD hold stops counting
    await holds.release(tenantA, exact.holdId, `${suffix}-rel`, { type: 'USER', userId: ids.agentin2 })
    expect((await credit(a)).committedMinor).toBe('60000')
    await prisma.inventoryHold.updateMany({ where: { tenantId: tenantA, createdByUserId: ids.agentin }, data: { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 60_000) } }) // the table requires expiry after creation
    expect((await credit(a)).committedMinor).toBe('0')
    // lowering the limit below what is committed leaves existing holds alone and refuses new ones
    await hold('agentin', 80000)
    await setLimit(a, { currency: 'AED', limitMinor: '50000' })
    expect(await credit(a)).toMatchObject({ committedMinor: '80000', availableMinor: '0' })
    await expect(hold('agentin', 1)).rejects.toMatchObject({ status: 403 })
    // removing the limit lifts the ceiling
    await setLimit(a, { limitMinor: null })
    expect((await credit(a)).limit).toBeNull(); await hold('agentin', 5_000_000)
  })

  it('CR-04 concurrent holds cannot both pass the limit', async () => {
    const a = await newAgency(['agentin3'])
    await setLimit(a, { currency: 'AED', limitMinor: '100000' })
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => hold('agentin3', 30000)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason?.status === 403)).toBe(true)
    expect((await credit(a)).committedMinor).toBe('90000')
  })

  it('CR-05 a limit is visible only to the tenant that owns the agency', async () => {
    const a = await newAgency([]); await setLimit(a, { currency: 'AED', limitMinor: '1234' })
    await api('get', `${base}/${a}`, 'badmin').expect(404)
    expect((await credit(a, 'reader')).limit).toEqual({ currency: 'AED', limitMinor: '1234' }) // agency.read may see it, not change it
    expect(await prisma.agencyCreditLimit.count({ where: { tenantId: tenantB } })).toBe(0)
  })
})
