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
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0061 Amendment 3, delivery step 1: cursor pagination for the extranet hotels and contracts lists. Keyset order with ties (equal hotel names, equal
 * contract start dates), no gaps or repeats across pages, bounded limits, malformed cursors, and scope that comes from the session, never the cursor.
 */
describe('Supplier extranet pagination (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `sp-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'supplier-page-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  let app: INestApplication
  let previousUrl: string | undefined
  let tenant = ''; let s1 = ''; let s2 = ''
  const hotelIds: string[] = []; const s1Hotels: string[] = []; const s2Hotels: string[] = []
  const s1Contracts: string[] = []
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}

  beforeAll(async () => {
    await owner.$connect()
    const passwordHash = await hashPassword(password)
    tenant = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    const supplier = (name: string) => owner.supplier.create({ data: { tenantId: tenant, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })
    ;[s1, s2] = (await Promise.all([supplier('Org1'), supplier('Org2')])).map((s) => s.id)

    // Seven hotels for org 1; three share one name so the id tiebreak is exercised. Two more for org 2, with a name that sorts among org 1's.
    const names = ['Alpha', 'Bravo', 'Bravo', 'Bravo', 'Charlie', 'Delta', 'Echo']
    for (const [index, name] of names.entries()) {
      const hotel = await owner.hotel.create({ data: { tenantId: tenant, name: `${suffix} ${name}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
      await owner.supplierHotelMapping.create({ data: { tenantId: tenant, supplierId: s1, hotelId: hotel.id, supplierHotelId: `S1-${index}`, status: index === 5 ? 'PENDING' : 'MAPPED' } })
      hotelIds.push(hotel.id); s1Hotels.push(hotel.id)
    }
    // A rejected mapping and an org-2 hotel must never appear for org 1.
    const rejected = await owner.hotel.create({ data: { tenantId: tenant, name: `${suffix} Bravo Rejected`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    await owner.supplierHotelMapping.create({ data: { tenantId: tenant, supplierId: s1, hotelId: rejected.id, supplierHotelId: 'S1-R', status: 'REJECTED' } })
    const other = await owner.hotel.create({ data: { tenantId: tenant, name: `${suffix} Bravo Other`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    await owner.supplierHotelMapping.create({ data: { tenantId: tenant, supplierId: s2, hotelId: other.id, supplierHotelId: 'S2-0', status: 'MAPPED' } })
    hotelIds.push(rejected.id, other.id); s2Hotels.push(other.id)

    // Contracts: five for org 1 (three share a start date), one for org 2. One org-1 contract has a rate plan.
    const board = await owner.boardBasis.create({ data: { tenantId: tenant, code: 'BB ', name: `Board ${suffix}` } })
    const room = await owner.roomType.create({ data: { hotelId: s1Hotels[0], name: 'Room', code: `${suffix}-r`, maxAdults: 2, maxOccupancy: 2 } })
    const starts = ['2099-01-01', '2099-01-01', '2099-01-01', '2099-03-01', '2098-06-01']
    for (const [index, validFrom] of starts.entries()) {
      const c = await owner.contract.create({ data: { tenantId: tenant, supplierId: s1, code: `${suffix}-C${index}`, validFrom: new Date(validFrom), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
      s1Contracts.push(c.id)
      if (index === 0) await owner.ratePlan.create({ data: { tenantId: tenant, contractId: c.id, roomTypeId: room.id, boardBasisId: board.id, code: 'RP1', occupancy: 2, currency: 'AED' } })
    }
    await owner.contract.create({ data: { tenantId: tenant, supplierId: s2, code: `${suffix}-OTHER`, validFrom: new Date('2099-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })

    const permissions = await Promise.all(['supplier.extranet.hotels.read', 'supplier.extranet.contracts.read'].map((key) => owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    async function user(label: string, supplierId: string) {
      const role = await owner.role.create({ data: { tenantId: tenant, name: `${suffix}-${label}` } }); roleIds.push(role.id)
      await owner.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })) })
      const created = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, passwordHash, name: label } }); userIds.push(created.id)
      await owner.membership.create({ data: { tenantId: tenant, userId: created.id, role: 'member' } })
      await owner.userRole.create({ data: { tenantId: tenant, userId: created.id, roleId: role.id } })
      await owner.supplierMembership.create({ data: { tenantId: tenant, userId: created.id, supplierId, status: 'ACTIVE' } })
    }
    await user('u1', s1); await user('u2', s2)

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['u1', 'u2']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    await owner.ratePlan.deleteMany({ where: { tenantId: tenant } })
    await owner.contract.deleteMany({ where: { tenantId: tenant } })
    await owner.boardBasis.deleteMany({ where: { tenantId: tenant } })
    await owner.roomType.deleteMany({ where: { hotelId: { in: hotelIds } } })
    await owner.supplierHotelMapping.deleteMany({ where: { tenantId: tenant } })
    await owner.hotel.deleteMany({ where: { id: { in: hotelIds } } })
    await owner.supplierMembership.deleteMany({ where: { tenantId: tenant } })
    await owner.supplier.deleteMany({ where: { id: { in: [s1, s2] } } })
    await owner.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await owner.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await owner.role.deleteMany({ where: { id: { in: roleIds } } })
    await owner.membership.deleteMany({ where: { userId: { in: userIds } } })
    await owner.session.deleteMany({ where: { userId: { in: userIds } } })
    await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: tenant } })
    await owner.$disconnect()
  }, 60_000)

  const get = (who: string, path: string, supplierId: string) => request(app.getHttpServer()).get(`/api/v1/supplier/extranet${path}`).set('Cookie', cookies[who]).set('Origin', origin).set('x-fbeds-tenant-id', tenant).set('x-fbeds-supplier-id', supplierId)

  async function walk(who: string, path: string, supplierId: string, limit: number, key: 'hotels' | 'contracts'): Promise<Array<{ id: string }>> {
    const seen: Array<{ id: string }> = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const res: request.Response = await get(who, `${path}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, supplierId).expect(200)
      const page = res.body.data[key] as Array<{ id: string }>
      expect(page.length).toBeLessThanOrEqual(limit)
      seen.push(...page)
      cursor = res.body.data.nextCursor
      if (!cursor) return seen
    }
    throw new Error('pagination did not terminate')
  }

  it('SP-01: hotels page in name order with no gaps or repeats, including equal names', async () => {
    const all = (await get('u1', '/hotels', s1).expect(200)).body.data
    expect(all.nextCursor).toBeNull()
    const expectedIds = [...all.hotels.map((h: { id: string }) => h.id)]
    expect(expectedIds.sort()).toEqual([...s1Hotels].sort())
    for (const limit of [1, 2, 3, 7]) {
      const paged = await walk('u1', '/hotels', s1, limit, 'hotels')
      expect(paged.map((h) => h.id)).toEqual(all.hotels.map((h: { id: string }) => h.id))
    }
    const names = all.hotels.map((h: { name: string }) => h.name)
    expect(names).toEqual([...names].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)))
  })

  it('SP-02: the first page reports a cursor only when there is more', async () => {
    const first = (await get('u1', '/hotels?limit=3', s1).expect(200)).body.data
    expect(first.hotels).toHaveLength(3); expect(typeof first.nextCursor).toBe('string')
    const exact = (await get('u1', '/hotels?limit=7', s1).expect(200)).body.data
    expect(exact.hotels).toHaveLength(7); expect(exact.nextCursor).toBeNull()
  })

  it('SP-03: contracts page newest-first with equal start dates, no gaps or repeats, plans included, no truncation flag', async () => {
    const all = (await get('u1', '/contracts', s1).expect(200)).body.data
    expect(all.nextCursor).toBeNull()
    expect(all.contracts.map((c: { id: string }) => c.id).sort()).toEqual([...s1Contracts].sort())
    expect(all.contracts.every((c: { ratePlansTruncated: boolean }) => c.ratePlansTruncated === false)).toBe(true)
    expect(all.contracts.flatMap((c: { ratePlans: unknown[] }) => c.ratePlans)).toHaveLength(1)
    const starts = all.contracts.map((c: { validFrom: string }) => c.validFrom)
    expect(starts).toEqual([...starts].sort().reverse())
    for (const limit of [1, 2, 4]) {
      const paged = await walk('u1', '/contracts', s1, limit, 'contracts')
      expect(paged.map((c) => c.id)).toEqual(all.contracts.map((c: { id: string }) => c.id))
    }
  })

  it('SP-04: limits are bounded and malformed cursors are rejected', async () => {
    for (const path of ['/hotels?limit=0', '/hotels?limit=51', '/hotels?limit=abc', '/contracts?limit=0', '/contracts?limit=51']) await get('u1', path, s1).expect(400)
    for (const cursor of ['not-a-cursor', Buffer.from('{}').toString('base64url'), Buffer.from('{"k":["a"]}').toString('base64url'), 'x'.repeat(701)]) {
      await get('u1', `/hotels?cursor=${encodeURIComponent(cursor)}`, s1).expect(400)
      await get('u1', `/contracts?cursor=${encodeURIComponent(cursor)}`, s1).expect(400)
    }
    await get('u1', `/contracts?cursor=${Buffer.from('{"k":["2099-13-45","c","i"]}').toString('base64url')}`, s1).expect(400)
    await get('u1', '/hotels?limit=2&extra=1', s1).expect(400)
  })

  it('SP-05: scope comes from the session, not the cursor: another organization never sees or is steered to the first organization\'s rows', async () => {
    const page = (await get('u1', '/hotels?limit=2', s1).expect(200)).body.data
    const asOther = (await get('u2', `/hotels?cursor=${encodeURIComponent(page.nextCursor)}`, s2).expect(200)).body.data
    expect(asOther.hotels.map((h: { id: string }) => h.id).every((id: string) => s2Hotels.includes(id))).toBe(true)
    const contractsPage = (await get('u1', '/contracts?limit=1', s1).expect(200)).body.data
    const otherContracts = (await get('u2', `/contracts?cursor=${encodeURIComponent(contractsPage.nextCursor)}`, s2).expect(200)).body.data
    expect(otherContracts.contracts.every((c: { id: string }) => !s1Contracts.includes(c.id))).toBe(true)
  })

  it('SP-06: a rejected mapping and another organization\'s hotel are never listed for org 1', async () => {
    const paged = await walk('u1', '/hotels', s1, 2, 'hotels')
    expect(paged.every((h) => s1Hotels.includes(h.id))).toBe(true)
    expect(paged).toHaveLength(7)
  })
})
