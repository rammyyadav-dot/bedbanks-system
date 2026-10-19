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
 * ADR 0061 Amendment 3, slice 4a, delivery step 2: supplier availability change sets. The application runs as the strict API runtime role. Covers the
 * validator through HTTP (own plans only, rates and pooled plans refused), the lifecycle (create, replace, submit, withdraw), idempotency, version
 * checks, the database guarantees (frozen cells, status edges, append-only history, row-level security) and that the runtime role cannot touch the live calendar.
 */
describe('Supplier availability change sets (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `cs-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'supplier-changes-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  let app: INestApplication
  let runtime: PrismaClient
  let previousUrl: string | undefined
  let tenantA = ''; let tenantB = ''
  let s1 = ''; let s2 = ''; let sB = ''
  let hotelA = ''; let hotelUnmapped = ''; let hotelB = ''
  let plan1 = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const code = (n: string) => `${n}-${suffix}`.toUpperCase()
  const P1 = () => code('P1'); const POOLED = () => code('POOLED'); const OTHER = () => code('OTHER')
  const HEADER = 'plan_code,date,allotment,stop_sell,min_stay,release_days'
  const csvFor = (...rows: string[]) => [HEADER, ...rows].join('\n')
  const key = () => `k-${randomBytes(8).toString('hex')}`
  let existingAvailabilityVersion = ''

  beforeAll(async () => {
    await owner.$connect()
    const passwordHash = await hashPassword(password)
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const supplier = (tenantId: string, name: string) => owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })
    ;[s1, s2] = (await Promise.all([supplier(tenantA, 'Org1'), supplier(tenantA, 'Org2')])).map((s) => s.id)
    sB = (await supplier(tenantB, 'OrgB')).id
    const hotel = (tenantId: string, name: string) => owner.hotel.create({ data: { tenantId, name: `${suffix} ${name}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    hotelA = (await hotel(tenantA, 'Hotel A')).id; hotelUnmapped = (await hotel(tenantA, 'Unmapped')).id; hotelB = (await hotel(tenantB, 'Hotel B')).id
    // Hotel A is mapped to both organizations; org 2 has its own contract and plan there. The unmapped hotel is mapped to nobody.
    await owner.supplierHotelMapping.createMany({ data: [
      { tenantId: tenantA, supplierId: s1, hotelId: hotelA, supplierHotelId: 'S1-A', status: 'MAPPED' },
      { tenantId: tenantA, supplierId: s2, hotelId: hotelA, supplierHotelId: 'S2-A', status: 'MAPPED' },
      { tenantId: tenantB, supplierId: sB, hotelId: hotelB, supplierHotelId: 'SB-B', status: 'MAPPED' },
    ] })
    const board = await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB ', name: `Board ${suffix}` } })
    const room = await owner.roomType.create({ data: { hotelId: hotelA, name: 'Room', code: `${suffix}-r`, maxAdults: 2, maxOccupancy: 3 } })
    const contract = (supplierId: string, n: string) => owner.contract.create({ data: { tenantId: tenantA, supplierId, code: `${suffix}-${n}`, validFrom: new Date('2099-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
    const [c1, c2] = await Promise.all([contract(s1, 'C1'), contract(s2, 'C2')])
    const pool = await owner.inventoryPool.create({ data: { tenantId: tenantA, hotelId: hotelA, supplierId: s1, name: `${suffix} pool`, createdById: 'u' } })
    const ratePlan = (contractId: string, c: string, inventoryPoolId?: string) => owner.ratePlan.create({ data: { tenantId: tenantA, contractId, roomTypeId: room.id, boardBasisId: board.id, code: c, occupancy: 2, currency: 'AED', ...(inventoryPoolId ? { inventoryPoolId } : {}) } })
    plan1 = (await ratePlan(c1.id, P1())).id
    await ratePlan(c1.id, POOLED(), pool.id); await ratePlan(c2.id, OTHER())
    // One existing live cell for plan 1: 10 allotted, 2 sold, 1 held.
    const existing = await owner.dailyAvailability.create({ data: { tenantId: tenantA, ratePlanId: plan1, stayDate: new Date('2099-03-05'), allotment: 10, sold: 2, held: 1 } })
    existingAvailabilityVersion = existing.updatedAt.toISOString()

    const permissions = await Promise.all(['supplier.extranet.changes.read', 'supplier.extranet.changes.author'].map((k) => owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })))
    const id = (k: string) => permissions.find((p) => p.key === k)!.id
    async function user(label: string, tenantId: string, permissionIds: string[], supplierId: string) {
      const role = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(role.id)
      if (permissionIds.length) await owner.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) })
      const created = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, passwordHash, name: label } }); userIds.push(created.id)
      await owner.membership.create({ data: { tenantId, userId: created.id, role: 'member' } })
      await owner.userRole.create({ data: { tenantId, userId: created.id, roleId: role.id } })
      await owner.supplierMembership.create({ data: { tenantId, userId: created.id, supplierId, status: 'ACTIVE' } })
    }
    const all = [id('supplier.extranet.changes.read'), id('supplier.extranet.changes.author')]
    await user('s1', tenantA, all, s1); await user('s2', tenantA, all, s2); await user('reader', tenantA, [id('supplier.extranet.changes.read')], s1)
    await user('none', tenantA, [], s1); await user('sb', tenantB, all, sB)

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    runtime = new PrismaClient({ datasourceUrl: u.toString() })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['s1', 's2', 'reader', 'none', 'sb']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close(); await runtime?.$disconnect()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    const tenants = [tenantA, tenantB]
    await owner.$transaction(async (tx) => {
      // The history is append-only and cells are frozen by trigger; the disposable fixture is removed with triggers off for this transaction only.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.supplierChangeSetEvent.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.supplierChangeSetCell.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.supplierChangeSet.deleteMany({ where: { tenantId: { in: tenants } } })
    })
    await owner.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.dailyAvailability.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.ratePlan.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.inventoryPool.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.contract.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.boardBasis.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.roomType.deleteMany({ where: { hotelId: { in: [hotelA, hotelUnmapped, hotelB] } } })
    await owner.supplierHotelMapping.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.supplierMembership.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.hotel.deleteMany({ where: { id: { in: [hotelA, hotelUnmapped, hotelB] } } })
    await owner.supplier.deleteMany({ where: { id: { in: [s1, s2, sB] } } })
    await owner.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await owner.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await owner.role.deleteMany({ where: { id: { in: roleIds } } })
    await owner.membership.deleteMany({ where: { userId: { in: userIds } } })
    await owner.session.deleteMany({ where: { userId: { in: userIds } } })
    await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: tenants } } })
    await owner.$disconnect()
  }, 60_000)

  const req = (method: 'get' | 'post' | 'put', who: string, tenantId: string, supplierId: string, path: string) =>
    request(app.getHttpServer())[method](`/api/v1/supplier/extranet/change-sets${path}`).set('Cookie', cookies[who]).set('Origin', origin).set('x-fbeds-tenant-id', tenantId).set('x-fbeds-supplier-id', supplierId)
  const as1 = (method: 'get' | 'post' | 'put', path: string, k: string | null = null) => { const r = req(method, 's1', tenantA, s1, path); return k ? r.set('Idempotency-Key', k) : r }
  const create = (csv: string, k: string | null = key(), hotelId = hotelA) => as1('post', '', k).send({ hotelId, csv })
  const draft = async (csv = csvFor(`${P1()},2099-04-01,5,false,2,`)) => (await create(csv).expect(201)).body.data.changeSet as { id: string; version: number; status: string }
  const reportCodes = (res: request.Response) => (res.body.error?.details ?? []).map((e: { code: string }) => e.code)
  const sets = () => owner.supplierChangeSet.count({ where: { tenantId: tenantA } })

  it('CS-01: preview validates and writes nothing', async () => {
    const before = await sets()
    const ok = await as1('post', '/preview').send({ hotelId: hotelA, csv: csvFor(`${P1()},2099-04-01,5,false,2,`, `${P1()},2099-04-02,0,true,1,`) }).expect(200)
    expect(ok.body.data).toMatchObject({ ok: true, errors: [] })
    expect(ok.body.data.cells).toHaveLength(2)
    expect(ok.body.data.cells[0]).not.toHaveProperty('expectedUpdatedAt')
    const bad = await as1('post', '/preview').send({ hotelId: hotelA, csv: csvFor(`${P1()},2099-03-05,1,false,1,`) }).expect(200)
    expect(bad.body.data.ok).toBe(false)
    expect(bad.body.data.errors.map((e: { code: string }) => e.code)).toEqual(['ALLOTMENT_BELOW_COMMITTED'])
    expect(await sets()).toBe(before)
  })

  it('CS-02: create stores a validated DRAFT with its cells, hash, history and audit event', async () => {
    const res = await create(csvFor(`${P1()},2099-04-10,6,false,2,3`, `${P1()},2099-03-05,12,true,1,`)).expect(201)
    const set = res.body.data.changeSet
    expect(res.body.data.replayed).toBe(false)
    expect(set).toMatchObject({ status: 'DRAFT', version: 1, cellCount: 2, hotelId: hotelA })
    expect(set.cells.map((c: { stayDate: string }) => c.stayDate)).toEqual(['2099-03-05', '2099-04-10'])
    expect(set.cells[1]).toMatchObject({ ratePlanCode: P1(), allotment: 6, stopSell: false, minStay: 2, releaseDays: 3 })
    expect(set.contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(set.events.map((e: { action: string }) => e.action)).toEqual(['created'])
    // The cell remembers the live version it was prepared against, for the staleness check at apply.
    const stored = await owner.supplierChangeSetCell.findFirstOrThrow({ where: { changeSetId: set.id, stayDate: new Date('2099-03-05') } })
    expect(stored.expectedUpdatedAt?.toISOString()).toBe(existingAvailabilityVersion)
    const audit = await owner.auditEvent.findMany({ where: { entityId: set.id, action: 'supplier.change_set.created' } })
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0].payload)).not.toContain(P1())
    // Nothing live changed.
    const live = await owner.dailyAvailability.findFirstOrThrow({ where: { ratePlanId: plan1, stayDate: new Date('2099-03-05') } })
    expect(live).toMatchObject({ allotment: 10, stopSell: false })
  })

  it('CS-03: a file with errors is refused with the row report and stores nothing', async () => {
    const before = await sets()
    const res = await create(csvFor(`${P1()},2099-04-01,5,false,2,`, `${P1()},2100-06-01,5,false,2,`)).expect(422)
    expect(res.body.error.code).toBe('CHANGE_SET_INVALID')
    expect(reportCodes(res)).toEqual(['DATE_OUTSIDE_CONTRACT'])
    expect(res.body.error.details[0]).toMatchObject({ line: 3, field: 'date' })
    expect(await sets()).toBe(before)
  })

  it('CS-04: another organization\'s plan, an unmapped hotel and another tenant\'s hotel do not exist for the caller', async () => {
    const other = await as1('post', '/preview').send({ hotelId: hotelA, csv: csvFor(`${OTHER()},2099-04-01,5,false,1,`) }).expect(200)
    expect(other.body.data.errors).toEqual([expect.objectContaining({ code: 'PLAN_NOT_FOUND' })])
    expect(JSON.stringify(other.body)).not.toMatch(/forbidden|permission/i)
    await create(csvFor(`${P1()},2099-04-01,5,false,2,`), key(), hotelUnmapped).expect(404)
    await create(csvFor(`${P1()},2099-04-01,5,false,2,`), key(), hotelB).expect(404)
  })

  it('CS-05: rates and pooled plans are refused', async () => {
    const rates = await as1('post', '/preview').send({ hotelId: hotelA, csv: `plan_code,date,amount,basis\n${P1()},2099-04-01,100.00,NET` }).expect(200)
    expect(rates.body.data.fatal[0]).toMatchObject({ code: 'RATES_NOT_ACCEPTED' })
    const pooled = await as1('post', '/preview').send({ hotelId: hotelA, csv: csvFor(`${POOLED()},2099-04-01,5,false,1,`) }).expect(200)
    expect(pooled.body.data.errors).toEqual([expect.objectContaining({ code: 'POOLED_PLAN' })])
    const before = await sets()
    await create(`plan_code,date,amount,basis\n${P1()},2099-04-01,100.00,NET`).expect(422)
    expect(await sets()).toBe(before)
  })

  it('CS-06: permissions: read-only can read but not author; none can do neither', async () => {
    const set = await draft()
    await req('get', 'reader', tenantA, s1, '').expect(200)
    await req('get', 'reader', tenantA, s1, `/${set.id}`).expect(200)
    await req('post', 'reader', tenantA, s1, '').set('Idempotency-Key', key()).send({ hotelId: hotelA, csv: csvFor(`${P1()},2099-04-02,5,false,1,`) }).expect(403)
    await req('post', 'reader', tenantA, s1, '/preview').send({ hotelId: hotelA, csv: csvFor(`${P1()},2099-04-02,5,false,1,`) }).expect(403)
    await req('post', 'reader', tenantA, s1, `/${set.id}/submit`).set('Idempotency-Key', key()).send({ expectedVersion: 1 }).expect(403)
    await req('get', 'none', tenantA, s1, '').expect(403)
    await req('get', 'none', tenantA, s1, `/${set.id}`).expect(403)
  })

  it('CS-07: idempotency: a key is required; the same key and body replays; the same key with another body conflicts', async () => {
    const csv = csvFor(`${P1()},2099-05-01,4,false,1,`)
    await create(csv, null).expect(400)
    await create(csv, 'short').expect(400)
    const k = key(); const before = await sets()
    const first = await create(csv, k).expect(201)
    const again = await create(csv, k).expect(201)
    expect(first.body.data.replayed).toBe(false); expect(again.body.data).toMatchObject({ replayed: true })
    expect(again.body.data.changeSet.id).toBe(first.body.data.changeSet.id)
    expect(await sets()).toBe(before + 1)
    expect(await owner.supplierChangeSetEvent.count({ where: { changeSetId: first.body.data.changeSet.id } })).toBe(1)
    const clash = await create(csvFor(`${P1()},2099-05-02,4,false,1,`), k).expect(409)
    expect(JSON.stringify(clash.body)).toContain('IDEMPOTENCY_CONFLICT')
  })

  it('CS-08: replace swaps the draft\'s cells and bumps the version; a stale version and a non-draft are refused', async () => {
    const set = await draft()
    const replaced = await as1('put', `/${set.id}`, key()).send({ csv: csvFor(`${P1()},2099-06-01,3,false,1,`, `${P1()},2099-06-02,3,false,1,`), expectedVersion: 1 }).expect(200)
    expect(replaced.body.data.changeSet).toMatchObject({ version: 2, cellCount: 2, status: 'DRAFT' })
    expect(replaced.body.data.changeSet.cells.map((c: { stayDate: string }) => c.stayDate)).toEqual(['2099-06-01', '2099-06-02'])
    expect(replaced.body.data.changeSet.events.map((e: { action: string }) => e.action)).toEqual(['created', 'replaced'])
    expect(JSON.stringify((await as1('put', `/${set.id}`, key()).send({ csv: csvFor(`${P1()},2099-06-03,3,false,1,`), expectedVersion: 1 }).expect(409)).body)).toContain('STALE_VERSION')
    await as1('post', `/${set.id}/submit`, key()).send({ expectedVersion: 2 }).expect(200)
    expect(JSON.stringify((await as1('put', `/${set.id}`, key()).send({ csv: csvFor(`${P1()},2099-06-03,3,false,1,`), expectedVersion: 2 }).expect(409)).body)).toContain('CHANGE_SET_NOT_DRAFT')
  })

  it('CS-09: submit freezes the set; the database refuses edits to cells, content and invalid status edges for every role', async () => {
    const set = await draft(csvFor(`${P1()},2099-07-01,5,false,1,`))
    const submitted = await as1('post', `/${set.id}/submit`, key()).send({ expectedVersion: 1 }).expect(200)
    expect(submitted.body.data.changeSet).toMatchObject({ status: 'SUBMITTED' })
    expect(submitted.body.data.changeSet.submittedAt).toEqual(expect.any(String))
    const raw = (sql: string) => owner.$executeRawUnsafe(sql)
    await expect(raw(`UPDATE supplier_change_set_cells SET allotment = 99 WHERE change_set_id = '${set.id}'`)).rejects.toThrow(/frozen/)
    await expect(raw(`DELETE FROM supplier_change_set_cells WHERE change_set_id = '${set.id}'`)).rejects.toThrow(/frozen/)
    await expect(raw(`INSERT INTO supplier_change_set_cells (id, tenant_id, supplier_id, change_set_id, rate_plan_id, stay_date, allotment, stop_sell, min_stay) VALUES ('x${suffix}', '${tenantA}', '${s1}', '${set.id}', '${plan1}', '2099-08-01', 1, false, 1)`)).rejects.toThrow(/frozen/)
    await expect(raw(`UPDATE supplier_change_sets SET content_sha256 = repeat('0', 64) WHERE id = '${set.id}'`)).rejects.toThrow(/frozen/)
    await expect(raw(`UPDATE supplier_change_sets SET status = 'DRAFT' WHERE id = '${set.id}'`)).rejects.toThrow(/cannot move/)
    await expect(raw(`UPDATE supplier_change_sets SET supplier_id = '${s2}' WHERE id = '${set.id}'`)).rejects.toThrow()
    await expect(raw(`UPDATE supplier_change_sets SET status = 'APPLIED' WHERE id = '${(await draft(csvFor(`${P1()},2099-07-02,5,false,1,`))).id}'`)).rejects.toThrow(/cannot move/)
  })

  it('CS-10: withdraw works from DRAFT and SUBMITTED, replays, and is final', async () => {
    const a = await draft(csvFor(`${P1()},2099-08-01,5,false,1,`))
    const k = key()
    const withdrawn = await as1('post', `/${a.id}/withdraw`, k).send({ expectedVersion: 1 }).expect(200)
    expect(withdrawn.body.data.changeSet.status).toBe('WITHDRAWN')
    expect((await as1('post', `/${a.id}/withdraw`, k).send({ expectedVersion: 1 }).expect(200)).body.data.replayed).toBe(true)
    expect(JSON.stringify((await as1('post', `/${a.id}/withdraw`, key()).send({ expectedVersion: 1 }).expect(409)).body)).toContain('CHANGE_SET_NOT_WITHDRAWABLE')
    expect(JSON.stringify((await as1('post', `/${a.id}/submit`, key()).send({ expectedVersion: 1 }).expect(409)).body)).toContain('CHANGE_SET_NOT_DRAFT')
    const b = await draft(csvFor(`${P1()},2099-08-02,5,false,1,`))
    await as1('post', `/${b.id}/submit`, key()).send({ expectedVersion: 1 }).expect(200)
    expect((await as1('post', `/${b.id}/withdraw`, key()).send({ expectedVersion: 1 }).expect(200)).body.data.changeSet.status).toBe('WITHDRAWN')
  })

  it('CS-11: list is newest first, filterable, paged, and shows only the caller\'s organization', async () => {
    const mine = (await as1('get', '?limit=50').expect(200)).body.data
    expect(mine.changeSets.length).toBeGreaterThanOrEqual(5)
    const created = mine.changeSets.map((c: { createdAt: string }) => c.createdAt)
    expect(created).toEqual([...created].sort().reverse())
    const seen: string[] = []; let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const page: request.Response = await as1('get', `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200)
      seen.push(...page.body.data.changeSets.map((c: { id: string }) => c.id)); cursor = page.body.data.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(mine.changeSets.map((c: { id: string }) => c.id))
    expect((await as1('get', '?status=WITHDRAWN').expect(200)).body.data.changeSets.every((c: { status: string }) => c.status === 'WITHDRAWN')).toBe(true)
    await as1('get', '?limit=0').expect(400)
    expect((await req('get', 's2', tenantA, s2, '').expect(200)).body.data.changeSets).toEqual([])
    expect((await req('get', 'sb', tenantB, sB, '').expect(200)).body.data.changeSets).toEqual([])
  })

  it('CS-12: another organization or tenant cannot read or change a set; it is not found', async () => {
    const set = await draft()
    await req('get', 's2', tenantA, s2, `/${set.id}`).expect(404)
    await req('put', 's2', tenantA, s2, `/${set.id}`).set('Idempotency-Key', key()).send({ csv: csvFor(`${OTHER()},2099-04-01,5,false,1,`), expectedVersion: 1 }).expect(404)
    await req('post', 's2', tenantA, s2, `/${set.id}/withdraw`).set('Idempotency-Key', key()).send({ expectedVersion: 1 }).expect(404)
    await req('get', 'sb', tenantB, sB, `/${set.id}`).expect(404)
    expect((await owner.supplierChangeSet.findUniqueOrThrow({ where: { id: set.id } })).status).toBe('DRAFT')
  })

  it('CS-13: row-level security: a supplier context sees only its organization; tenant context sees the tenant; no context sees nothing', async () => {
    const count = (setup: string[]) => runtime.$transaction(async (tx) => {
      for (const sql of setup) await tx.$executeRawUnsafe(sql)
      return Number((await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM supplier_change_sets`))[0].n)
    })
    const tenantSql = `SELECT set_config('app.current_tenant_id', '${tenantA}', true)`
    const total = await owner.supplierChangeSet.count({ where: { tenantId: tenantA } })
    const own = await owner.supplierChangeSet.count({ where: { tenantId: tenantA, supplierId: s1 } })
    expect(own).toBe(total)
    expect(await count([tenantSql, `SELECT set_config('app.current_supplier_id', '${s1}', true)`])).toBe(own)
    expect(await count([tenantSql, `SELECT set_config('app.current_supplier_id', '${s2}', true)`])).toBe(0)
    expect(await count([tenantSql])).toBe(total)
    expect(await count([])).toBe(0)
    expect(await count([`SELECT set_config('app.current_tenant_id', '${tenantB}', true)`, `SELECT set_config('app.current_supplier_id', '${s1}', true)`])).toBe(0)
  })

  it('CS-14: the runtime role cannot touch the live calendar, the review columns, the history or delete a set', async () => {
    const set = await draft()
    const sql = (text: string) => runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`)
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_supplier_id', '${s1}', true)`)
      return tx.$executeRawUnsafe(text)
    })
    await expect(sql(`UPDATE "DailyAvailability" SET allotment = 0`)).rejects.toThrow()
    await expect(sql(`INSERT INTO "DailyAvailability" (id, tenant_id, rate_plan_id, stay_date, allotment, stop_sell, min_stay, updated_at) VALUES ('z${suffix}', '${tenantA}', '${plan1}', '2099-09-09', 1, false, 1, now())`)).rejects.toThrow()
    await expect(sql(`UPDATE "DailyRate" SET amount_minor = 1`)).rejects.toThrow()
    await expect(sql(`UPDATE "RatePlan" SET status = 'ACTIVE'`)).rejects.toThrow()
    await expect(sql(`UPDATE supplier_change_sets SET decided_by_user_id = 'x' WHERE id = '${set.id}'`)).rejects.toThrow(/permission denied/)
    await expect(sql(`UPDATE supplier_change_sets SET failure_code = 'x' WHERE id = '${set.id}'`)).rejects.toThrow(/permission denied/)
    await expect(sql(`DELETE FROM supplier_change_sets WHERE id = '${set.id}'`)).rejects.toThrow(/permission denied/)
    await expect(sql(`UPDATE supplier_change_set_events SET action = 'x'`)).rejects.toThrow()
    await expect(sql(`DELETE FROM supplier_change_set_events`)).rejects.toThrow()
    await expect(sql(`UPDATE supplier_change_set_cells SET allotment = 1 WHERE change_set_id = '${set.id}'`)).rejects.toThrow(/permission denied/)
    const live = await owner.dailyAvailability.findFirstOrThrow({ where: { ratePlanId: plan1, stayDate: new Date('2099-03-05') } })
    expect(live.updatedAt.toISOString()).toBe(existingAvailabilityVersion)
  })

  it('CS-15: the history is append-only for every role and the audit trail carries no file content', async () => {
    const set = await draft(csvFor(`${P1()},2099-10-01,5,false,1,`))
    await as1('post', `/${set.id}/submit`, key()).send({ expectedVersion: 1 }).expect(200)
    const events = await owner.supplierChangeSetEvent.findMany({ where: { changeSetId: set.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => [e.action, e.fromStatus, e.toStatus])).toEqual([['created', null, 'DRAFT'], ['submitted', 'DRAFT', 'SUBMITTED']])
    await expect(owner.$executeRawUnsafe(`UPDATE supplier_change_set_events SET action = 'x' WHERE change_set_id = '${set.id}'`)).rejects.toThrow(/append-only/)
    await expect(owner.$executeRawUnsafe(`DELETE FROM supplier_change_set_events WHERE change_set_id = '${set.id}'`)).rejects.toThrow(/append-only/)
    const audits = await owner.auditEvent.findMany({ where: { entityId: set.id } })
    expect(audits.map((a) => a.action).sort()).toEqual(['supplier.change_set.created', 'supplier.change_set.submitted'])
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/plan_code|2099-10-01|RACK/)
  })
})
