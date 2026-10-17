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
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { runBookingSupplierBackfill } from '../src/database/booking-supplier-backfill'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0061 Amendment 1, slice 2. The whole application runs as the provisioned strict runtime role (non-superuser, non-BYPASSRLS, column-only booking
 * reads); fixtures and the ownership/backfill checks use the owner connection. Covers: ownership frozen at creation, the immutability and tenant
 * safeguards in PostgreSQL, tenant/supplier isolation over HTTP, bounded pagination, minimal DTOs (no sell/markup/FX/agency/snapshot), and the
 * conservative historical backfill with its reconciliation report.
 */
describe('Supplier extranet bookings (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `sb-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'supplier-bookings-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  // Values that must never appear in any supplier response.
  const SELL = 987654321
  const SECRETS = ['987654321', '55501234', '1.23456789', 'AGENT-SECRET-REF', 'SNAPSHOT-SECRET', 'GUEST-SECOND-SECRET', 'agency-secret-name']
  let app: INestApplication
  let runtime: PrismaClient
  let previousUrl: string | undefined
  let tenantA = ''; let tenantB = ''
  let s1 = ''; let s2 = ''; let sB = ''
  let hotelA = ''; let hotelB = ''
  let agencyId = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const emails: Record<string, string> = {}
  const bookings: Record<string, string> = {}
  const refs: Record<string, string> = {}
  let seq = 0

  async function fixtureBooking(label: string, input: { tenantId: string; supplierId: string | null; hotelId: string; channel?: 'PORTAL' | 'MANUAL' | 'API'; createdAt: Date; status?: 'CONFIRMED' | 'PENDING_SUPPLIER'; checkIn: string; rooms: (bigint | null)[]; bookingNet?: bigint | null; snapshot?: Record<string, unknown>; total?: bigint }) {
    const reference = `FB-${suffix.toUpperCase().replace(/[^A-Z0-9]/g, '')}${(++seq).toString().padStart(3, '0')}`
    const checkIn = new Date(`${input.checkIn}T00:00:00.000Z`)
    const checkOut = new Date(checkIn.getTime() + 2 * 86_400_000)
    const created = await owner.booking.create({ data: {
      tenantId: input.tenantId, reference, supplier: 'contracted-inventory', supplierId: input.supplierId, hotelId: input.hotelId, status: input.status ?? 'CONFIRMED',
      currency: 'AED', totalMinor: input.total ?? BigInt(SELL), idempotencyKey: `${suffix}-${label}`, searchSnapshot: { marker: 'SNAPSHOT-SECRET', ...(input.snapshot ?? {}) },
      channel: input.channel ?? 'PORTAL', agencyId: input.tenantId === tenantA ? agencyId : null, agentRef: 'AGENT-SECRET-REF', checkIn, checkOut, nights: 2, markupMinor: 55501234n, fxRate: '1.23456789', netMinor: input.bookingNet ?? null,
      supplierRef: `SUP-${label}`, hotelConfirmationNo: `HCN-${label}`, createdAt: input.createdAt,
    } })
    for (const [index, net] of input.rooms.entries()) {
      const room = await owner.bookingRoom.create({ data: { tenantId: input.tenantId, bookingId: created.id, position: index + 1, quantity: 1, roomName: `Room ${label} ${index + 1}`, boardCode: 'BB', adults: 2, netMinor: net, sellMinor: BigInt(SELL) } })
      if (index === 0) {
        await owner.bookingGuest.create({ data: { tenantId: input.tenantId, bookingId: created.id, roomId: room.id, firstName: 'Lead', lastName: `Guest${label}`, isLead: true } })
        await owner.bookingGuest.create({ data: { tenantId: input.tenantId, bookingId: created.id, roomId: room.id, firstName: 'GUEST-SECOND-SECRET', lastName: 'Other', isLead: false } })
      }
    }
    bookings[label] = created.id
    refs[label] = reference
    return created
  }

  beforeAll(async () => {
    await owner.$connect()
    const passwordHash = await hashPassword(password)
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const supplier = (tenantId: string, name: string) => owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })
    ;[s1, s2] = (await Promise.all([supplier(tenantA, 'Org1'), supplier(tenantA, 'Org2')])).map((s) => s.id)
    sB = (await supplier(tenantB, 'OrgB')).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} Hotel B`, propertyType: 'HOTEL', city: 'Muscat', countryCode: 'OM' } })).id

    const permissions = await Promise.all(['supplier.extranet.bookings.read', 'supplier.extranet.hotels.read'].map((key) => owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const bookingsRead = permissions.find((p) => p.key === 'supplier.extranet.bookings.read')!.id
    const hotelsRead = permissions.find((p) => p.key === 'supplier.extranet.hotels.read')!.id
    async function user(key: string, tenantId: string, permissionIds: string[], supplierId: string | null) {
      const role = await owner.role.create({ data: { tenantId, name: `${suffix}-${key}` } }); roleIds.push(role.id)
      if (permissionIds.length) await owner.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) })
      const email = `${suffix}-${key}@example.test`; emails[key] = email
      const created = await owner.user.create({ data: { email, passwordHash, name: key } }); userIds.push(created.id)
      await owner.membership.create({ data: { tenantId, userId: created.id, role: 'member' } })
      await owner.userRole.create({ data: { tenantId, userId: created.id, roleId: role.id } })
      if (supplierId) await owner.supplierMembership.create({ data: { tenantId, userId: created.id, supplierId, status: 'ACTIVE' } })
    }
    await user('s1', tenantA, [bookingsRead], s1)
    await user('s2', tenantA, [bookingsRead], s2)
    await user('noperm', tenantA, [hotelsRead], s1)
    await user('sb', tenantB, [bookingsRead], sB)

    agencyId = (await owner.agency.create({ data: { tenantId: tenantA, code: `SB${randomBytes(3).toString("hex").toUpperCase()}`, name: "agency-secret-name", countryCode: 'AE', createdById: userIds[0] } })).id

    const t = (iso: string) => new Date(iso)
    // Supplier 1 (own): five bookings with distinct, ordered creation times. Two share one timestamp to exercise the id tiebreak.
    await fixtureBooking('own1', { tenantId: tenantA, supplierId: s1, hotelId: hotelA, createdAt: t('2099-01-05T10:00:00.000Z'), checkIn: '2099-03-01', rooms: [100000n, 250000n], bookingNet: 350000n })
    await fixtureBooking('own2', { tenantId: tenantA, supplierId: s1, hotelId: hotelA, createdAt: t('2099-01-04T10:00:00.000Z'), checkIn: '2099-03-10', rooms: [null, null], status: 'PENDING_SUPPLIER' })
    await fixtureBooking('own3', { tenantId: tenantA, supplierId: s1, hotelId: hotelA, createdAt: t('2099-01-03T10:00:00.000Z'), checkIn: '2099-04-01', rooms: [100000n, null] })
    await fixtureBooking('own4', { tenantId: tenantA, supplierId: s1, hotelId: hotelA, createdAt: t('2099-01-02T10:00:00.000Z'), checkIn: '2099-04-15', rooms: [100000n, 100000n], bookingNet: 999n })
    await fixtureBooking('own5', { tenantId: tenantA, supplierId: s1, hotelId: hotelA, createdAt: t('2099-01-02T10:00:00.000Z'), checkIn: '2099-05-01', rooms: [70000n] })
    // Not supplier 1's: another organization, a connector/manual booking without an organization, another tenant.
    await fixtureBooking('other', { tenantId: tenantA, supplierId: s2, hotelId: hotelA, createdAt: t('2099-01-06T10:00:00.000Z'), checkIn: '2099-03-02', rooms: [1n] })
    await fixtureBooking('connector', { tenantId: tenantA, supplierId: null, hotelId: hotelA, channel: 'MANUAL', createdAt: t('2099-01-07T10:00:00.000Z'), checkIn: '2099-03-03', rooms: [2n] })
    await fixtureBooking('tenantb', { tenantId: tenantB, supplierId: sB, hotelId: hotelB, createdAt: t('2099-01-08T10:00:00.000Z'), checkIn: '2099-03-04', rooms: [3n] })

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    runtime = new PrismaClient({ datasourceUrl: u.toString() })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await runtime?.$disconnect()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    const tenants = [tenantA, tenantB]
    // Booking events are append-only by trigger; the disposable fixture is removed with triggers off for this transaction only.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      // Foreign-key cascades are triggers and are off in replica mode: delete the children first.
      await tx.bookingGuest.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.bookingRoom.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.bookingEvent.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.booking.deleteMany({ where: { tenantId: { in: tenants } } })
    })
    await owner.supplierMutation.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.inventoryHold.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.ratePlan.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.contract.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.boardBasis.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.agencyMember.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.agency.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.supplierMembership.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.roomType.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } })
    await owner.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } })
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

  async function login(key: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: emails[key], password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const get = (cookie: string, tenantId: string, path: string, supplierId?: string) => {
    const test = request(app.getHttpServer()).get(`/api/v1/supplier/extranet${path}`).set('Cookie', cookie).set('Origin', origin).set('x-fbeds-tenant-id', tenantId)
    return supplierId ? test.set('x-fbeds-supplier-id', supplierId) : test
  }
  const assertNoSecrets = (body: unknown) => {
    const text = JSON.stringify(body)
    for (const secret of SECRETS) expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false })
    for (const key of ['totalMinor', 'sellMinor', 'markupMinor', 'fxRate', 'agencyId', 'agentRef', 'agentUserId', 'searchSnapshot', 'channel', 'paymentMode', 'idempotencyKey', 'walletId', 'supplier"']) {
      expect({ key, leaked: text.includes(`"${key}`) || (key === 'supplier"' && text.includes('"supplier":')) }).toEqual({ key, leaked: false })
    }
  }

  // ---- Ownership at creation (real service, real PostgreSQL) -------------------------------------------------------------------------------
  describe('ownership is frozen at creation from hold -> rate plan -> contract', () => {
    let holdOf: (supplierId: string, tenantId: string, netAmountMinor?: bigint | null) => Promise<{ holdId: string; ratePlanId: string; roomTypeId: string; boardBasisId: string; hotelId: string }>
    const ownerPrisma = { withTenant: <T>(tenantId: string, work: (tx: never) => Promise<T>) => owner.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`; return work(tx as never) }) }
    beforeAll(() => {
      holdOf = async (supplierId, tenantId, netAmountMinor: bigint | null = null) => {
        const hotelId = tenantId === tenantA ? hotelA : hotelB
        const n = ++seq
        const board = await owner.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB ' } }, update: {}, create: { tenantId, code: 'BB ', name: `Board ${suffix}` } })
        const room = await owner.roomType.create({ data: { hotelId, name: `Room ${n}`, code: `${suffix}-${n}`, maxAdults: 2, maxOccupancy: 2 } })
        const contract = await owner.contract.create({ data: { tenantId, supplierId, code: `${suffix}-C${n}`, validFrom: new Date('2099-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
        const plan = await owner.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: `RP${n}`, occupancy: 2, currency: 'AED' } })
        const hold = await owner.inventoryHold.create({ data: {
          tenantId, ratePlanId: plan.id, offerId: `offer-${n}`, searchId: `search-${n}`, canonicalHotelId: hotelId, canonicalRoomTypeId: room.id, boardBasisId: board.id,
          checkIn: new Date('2099-06-01'), checkOut: new Date('2099-06-03'), rooms: 1, currency: 'AED', sellAmountMinor: 125099n, netAmountMinor, idempotencyKey: `${suffix}-h${n}`,
          requestFingerprint: 'f'.repeat(64), requestId: 'r', createdByUserId: userIds[0] ?? 'u', status: 'HELD', expiresAt: new Date(Date.now() + 3_600_000),
        } })
        return { holdId: hold.id, ratePlanId: plan.id, roomTypeId: room.id, boardBasisId: board.id, hotelId }
      }
    })
    const commandFor = (tenantId: string, h: { holdId: string; ratePlanId: string; roomTypeId: string; boardBasisId: string; hotelId: string }, key: string) => ({
      tenantId, userId: userIds[0], requestId: 'req', idempotencyKey: key, offerId: `offer`, searchId: 'search', inventoryHoldId: h.holdId, canonicalHotelId: h.hotelId,
      canonicalRoomTypeId: h.roomTypeId, ratePlanId: h.ratePlanId, boardBasisId: h.boardBasisId, checkIn: '2099-06-01', checkOut: '2099-06-03', rooms: 1, adults: 2, children: 0, childAges: [],
      currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Lead', lastName: 'Created' },
    })

    it('sets Booking.supplier_id from the contract in the creating transaction and never rewrites it on replay', async () => {
      const h = await holdOf(s1, tenantA)
      await owner.inventoryHold.update({ where: { id: h.holdId }, data: { offerId: 'offer', searchId: 'search' } })
      const service = new BookingPersistenceService(ownerPrisma as never)
      const created = await service.persistPending(commandFor(tenantA, h, `${suffix}-persist-1`) as never)
      const row = await owner.booking.findUniqueOrThrow({ where: { id: created.id }, select: { supplierId: true, supplier: true } })
      expect(row).toEqual({ supplierId: s1, supplier: 'PENDING_SUPPLIER' })
      bookings.persisted = created.id
      // Even if the contract later moves to another supplier, the booking keeps its owner; a replay returns the same row unchanged.
      await owner.contract.updateMany({ where: { ratePlans: { some: { id: h.ratePlanId } } }, data: { supplierId: s2 } })
      const replay = await service.persistPending(commandFor(tenantA, h, `${suffix}-persist-1`) as never)
      expect(replay.id).toBe(created.id)
      expect((await owner.booking.findUniqueOrThrow({ where: { id: created.id }, select: { supplierId: true } })).supplierId).toBe(s1)
    })

    it('carries the hold\'s supplier net onto the room line, which the extranet then shows as a recorded net (ADR 0061 Amendment 2)', async () => {
      const h = await holdOf(s1, tenantA, 98765n)
      await owner.inventoryHold.update({ where: { id: h.holdId }, data: { offerId: 'offer', searchId: 'search' } })
      const service = new BookingPersistenceService(ownerPrisma as never)
      const created = await service.persistPending(commandFor(tenantA, h, `${suffix}-persist-net`) as never)
      const room = await owner.bookingRoom.findFirstOrThrow({ where: { bookingId: created.id }, select: { netMinor: true, sellMinor: true } })
      expect(room).toEqual({ netMinor: 98765n, sellMinor: 125099n })
      // The finance-facing booking-level net is not written by this path.
      expect((await owner.booking.findUniqueOrThrow({ where: { id: created.id }, select: { netMinor: true } })).netMinor).toBeNull()
      bookings.persistedNet = created.id
      const detail = await get(await login('s1'), tenantA, `/bookings/${created.id}`).expect(200)
      expect(detail.body.data).toMatchObject({ netStatus: 'RECORDED', netMinor: '98765' })
      expect(detail.body.data.rooms).toMatchObject([{ netMinor: '98765' }])
      assertNoSecrets(detail.body)
    })

    it('fails closed and creates nothing when the hold belongs to a rate plan that is not in the tenant', async () => {
      const h = await holdOf(sB, tenantB)
      const service = new BookingPersistenceService(ownerPrisma as never)
      await expect(service.persistPending(commandFor(tenantA, h, `${suffix}-persist-x`) as never)).rejects.toBeDefined()
      expect(await owner.booking.count({ where: { idempotencyKey: `${suffix}-persist-x` } })).toBe(0)
    })
  })

  // ---- Database safeguards --------------------------------------------------------------------------------------------------------------
  describe('PostgreSQL safeguards', () => {
    it('refuses to change or clear a non-null supplier_id, from any role', async () => {
      await expect(owner.booking.update({ where: { id: bookings.own1 }, data: { supplierId: s2 } })).rejects.toThrow(/immutable/)
      await expect(owner.booking.update({ where: { id: bookings.own1 }, data: { supplierId: null } })).rejects.toThrow(/immutable/)
      expect((await owner.booking.findUniqueOrThrow({ where: { id: bookings.own1 }, select: { supplierId: true } })).supplierId).toBe(s1)
    })

    it('refuses a supplier from another tenant and refuses to delete a supplier that owns bookings', async () => {
      await expect(owner.booking.update({ where: { id: bookings.connector }, data: { supplierId: sB } })).rejects.toThrow()
      await expect(owner.supplier.delete({ where: { id: s1 } })).rejects.toThrow()
      expect((await owner.booking.findUniqueOrThrow({ where: { id: bookings.connector }, select: { supplierId: true } })).supplierId).toBeNull()
    })

    it('lets the strict runtime login read only the granted booking columns and write nothing', async () => {
      await expect(runtime.$queryRawUnsafe('SELECT "total_minor" FROM "Booking" LIMIT 1')).rejects.toThrow(/permission denied/)
      await expect(runtime.$queryRawUnsafe('SELECT "markup_minor", "fx_rate", "agency_id", "search_snapshot" FROM "Booking" LIMIT 1')).rejects.toThrow(/permission denied/)
      await expect(runtime.$queryRawUnsafe('SELECT * FROM "Booking" LIMIT 1')).rejects.toThrow(/permission denied/)
      await expect(runtime.$queryRawUnsafe('SELECT "sell_minor" FROM "BookingRoom" LIMIT 1')).rejects.toThrow(/permission denied/)
      await expect(runtime.$executeRawUnsafe(`UPDATE "Booking" SET "supplier_id" = NULL WHERE false`)).rejects.toThrow(/permission denied/)
      await expect(runtime.$executeRawUnsafe(`DELETE FROM "BookingRoom" WHERE false`)).rejects.toThrow(/permission denied/)
    })
  })

  // ---- HTTP ---------------------------------------------------------------------------------------------------------------------------
  describe('GET /supplier/extranet/bookings', () => {
    it('requires authentication and the explicit permission', async () => {
      await request(app.getHttpServer()).get('/api/v1/supplier/extranet/bookings').expect(401)
      const cookie = await login('noperm')
      const denied = await get(cookie, tenantA, '/bookings').expect(403)
      assertNoSecrets(denied.body)
    })

    it('returns only the caller organization\'s bookings, newest first, with a stable id tiebreak', async () => {
      const cookie = await login('s1')
      const response = await get(cookie, tenantA, '/bookings?limit=50').expect(200)
      const ids = response.body.data.bookings.map((b: { id: string }) => b.id)
      expect(ids).toEqual([bookings.own1, bookings.own2, bookings.own3, ...[bookings.own4, bookings.own5].sort().reverse(), bookings.persistedNet, bookings.persisted]) // persisted: created by the real service in the first describe, owned by s1
      for (const hidden of ['other', 'connector', 'tenantb']) expect(ids).not.toContain(bookings[hidden])
      expect(response.body.data.nextCursor).toBeNull()
      assertNoSecrets(response.body)
    })

    it('pages with an opaque cursor, without gaps or repeats, and bounds the page size', async () => {
      const cookie = await login('s1')
      const seen: string[] = []
      let cursor: string | null = null
      for (let guard = 0; guard < 10; guard++) {
        const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const page: request.Response = await get(cookie, tenantA, `/bookings${query}`).expect(200)
        expect(page.body.data.bookings.length).toBeLessThanOrEqual(2)
        seen.push(...page.body.data.bookings.map((b: { id: string }) => b.id))
        cursor = page.body.data.nextCursor
        if (!cursor) break
      }
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      await get(cookie, tenantA, '/bookings?limit=0').expect(400)
      await get(cookie, tenantA, '/bookings?limit=51').expect(400)
      await get(cookie, tenantA, '/bookings?cursor=not-a-cursor').expect(400)
      await get(cookie, tenantA, '/bookings?supplierId=' + s2).expect(400) // not a filter: unknown parameters are refused
      const forged = Buffer.from(JSON.stringify({ c: '2099-01-01T00:00:00.000Z', i: bookings.other, s: s2, t: tenantB })).toString('base64url')
      const viaForged = await get(cookie, tenantA, `/bookings?cursor=${forged}`).expect(200)
      expect(viaForged.body.data.bookings.map((b: { id: string }) => b.id)).not.toContain(bookings.other)
    })

    it('filters by status, arrival date range and reference prefix, and rejects invalid filters', async () => {
      const cookie = await login('s1')
      const pending = await get(cookie, tenantA, '/bookings?status=PENDING_SUPPLIER').expect(200)
      expect(pending.body.data.bookings.map((b: { id: string }) => b.id).sort()).toEqual([bookings.own2, bookings.persisted, bookings.persistedNet].sort())
      const range = await get(cookie, tenantA, '/bookings?checkInFrom=2099-04-01&checkInTo=2099-04-30').expect(200)
      expect(range.body.data.bookings.map((b: { id: string }) => b.id).sort()).toEqual([bookings.own3, bookings.own4].sort())
      const byRef = await get(cookie, tenantA, `/bookings?reference=${refs.own5.toLowerCase()}`).expect(200)
      expect(byRef.body.data.bookings.map((b: { id: string }) => b.id)).toEqual([bookings.own5])
      const otherRef = await get(cookie, tenantA, `/bookings?reference=${refs.other}`).expect(200)
      expect(otherRef.body.data.bookings).toEqual([])
      await get(cookie, tenantA, '/bookings?status=BOGUS').expect(400)
      await get(cookie, tenantA, '/bookings?checkInFrom=2099-13-45').expect(400)
      await get(cookie, tenantA, '/bookings?checkInFrom=2099-05-01&checkInTo=2099-04-01').expect(400)
      await get(cookie, tenantA, "/bookings?reference=%27%20OR%201=1").expect(400)
    })

    it('reports room-level net as Not recorded, partial, mismatched or reconciled, never as zero', async () => {
      const cookie = await login('s1')
      const list = await get(cookie, tenantA, '/bookings?limit=50').expect(200)
      const by = new Map<string, { netStatus: string; netMinor: string | null }>(list.body.data.bookings.map((b: { id: string; netStatus: string; netMinor: string | null }) => [b.id, b]))
      expect(by.get(bookings.own1)).toMatchObject({ netStatus: 'RECORDED', netMinor: '350000' })
      expect(by.get(bookings.own2)).toMatchObject({ netStatus: 'NOT_RECORDED', netMinor: null })
      expect(by.get(bookings.own3)).toMatchObject({ netStatus: 'PARTIAL', netMinor: null })
      expect(by.get(bookings.own4)).toMatchObject({ netStatus: 'MISMATCH', netMinor: null })
      expect(by.get(bookings.own5)).toMatchObject({ netStatus: 'RECORDED', netMinor: '70000' })
    })

    it('returns minimal detail with room lines and the lead guest only', async () => {
      const cookie = await login('s1')
      const detail = await get(cookie, tenantA, `/bookings/${bookings.own1}`).expect(200)
      expect(detail.body.data).toMatchObject({
        id: bookings.own1, reference: refs.own1, status: 'CONFIRMED', hotelName: `${suffix} Hotel A`, currency: 'AED', checkIn: '2099-03-01', checkOut: '2099-03-03', nights: 2,
        leadGuestName: 'Lead Guestown1', supplierRef: 'SUP-own1', hotelConfirmationNo: 'HCN-own1', netMinor: '350000', netStatus: 'RECORDED',
      })
      expect(detail.body.data.rooms).toEqual([
        { position: 1, roomName: 'Room own1 1', boardCode: 'BB', quantity: 1, adults: 2, children: 0, netMinor: '100000' },
        { position: 2, roomName: 'Room own1 2', boardCode: 'BB', quantity: 1, adults: 2, children: 0, netMinor: '250000' },
      ])
      assertNoSecrets(detail.body)
      const missing = await get(cookie, tenantA, `/bookings/${bookings.own2}`).expect(200)
      expect(missing.body.data.rooms.map((r: { netMinor: unknown }) => r.netMinor)).toEqual([null, null])
    })

    it('fails closed across suppliers, tenants, missing ownership and forged selectors, without leaking anything in errors', async () => {
      const cookie1 = await login('s1')
      for (const label of ['other', 'connector', 'tenantb']) {
        const response = await get(cookie1, tenantA, `/bookings/${bookings[label]}`).expect(404)
        assertNoSecrets(response.body)
        // One generic message for out-of-scope, unattributed and foreign-tenant ids alike: existence is not revealed.
        expect(JSON.stringify(response.body)).toContain('Booking not found')
        expect(response.body.data).toBeUndefined()
      }
      await get(cookie1, tenantA, '/bookings/does-not-exist').expect(404)
      await get(cookie1, tenantA, '/bookings', s2).expect(403) // header may only select among the caller's own memberships
      await get(cookie1, tenantB, '/bookings').expect(403)
      await get(cookie1, tenantA, `/bookings/${bookings.own1}`, 'forged').expect(403)
      const cookie2 = await login('s2')
      const list2 = await get(cookie2, tenantA, '/bookings').expect(200)
      expect(list2.body.data.bookings.map((b: { id: string }) => b.id)).toEqual([bookings.other])
      await get(cookie2, tenantA, `/bookings/${bookings.own1}`).expect(404)
      const cookieB = await login('sb')
      const listB = await get(cookieB, tenantB, '/bookings').expect(200)
      expect(listB.body.data.bookings.map((b: { id: string }) => b.id)).toEqual([bookings.tenantb])
      await get(cookieB, tenantB, `/bookings/${bookings.own1}`).expect(404)
      await get(cookieB, tenantA, '/bookings').expect(403)
    })

    it('changes no row: the endpoints are read-only', async () => {
      const before = await owner.booking.findMany({ where: { tenantId: tenantA }, select: { id: true, updatedAt: true, version: true, status: true } })
      const cookie = await login('s1')
      await get(cookie, tenantA, '/bookings').expect(200)
      await get(cookie, tenantA, `/bookings/${bookings.own1}`).expect(200)
      await request(app.getHttpServer()).patch(`/api/v1/supplier/extranet/bookings/${bookings.own1}`).set('Cookie', cookie).set('Origin', origin).set('x-fbeds-tenant-id', tenantA).send({ status: 'CANCELLED' }).expect(404)
      await request(app.getHttpServer()).post(`/api/v1/supplier/extranet/bookings/${bookings.own1}/confirm`).set('Cookie', cookie).set('Origin', origin).set('x-fbeds-tenant-id', tenantA).send({}).expect(404)
      const after = await owner.booking.findMany({ where: { tenantId: tenantA }, select: { id: true, updatedAt: true, version: true, status: true } })
      expect(after).toEqual(before)
    })
  })

  // ---- Historical backfill ------------------------------------------------------------------------------------------------------------
  describe('historical backfill', () => {
    const legacy: Record<string, string> = {}
    let planS1 = ''; let holdOk = ''; let holdDup = ''; let holdMismatch = ''; let holdForeign = ''; let holdMutation = ''
    beforeAll(async () => {
      const mk = async (tenantId: string, supplierId: string, hotelId: string, tag: string, amount = 777000n) => {
        const n = ++seq
        const board = await owner.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB ' } }, update: {}, create: { tenantId, code: 'BB ', name: `Board ${suffix}` } })
        const room = await owner.roomType.create({ data: { hotelId, name: `BF Room ${n}`, code: `${suffix}-bf${n}`, maxAdults: 2, maxOccupancy: 2 } })
        const contract = await owner.contract.create({ data: { tenantId, supplierId, code: `${suffix}-BF${n}`, validFrom: new Date('2099-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
        const plan = await owner.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: `BF${n}`, occupancy: 2, currency: 'AED' } })
        const hold = await owner.inventoryHold.create({ data: {
          tenantId, ratePlanId: plan.id, offerId: `o-${tag}`, searchId: `s-${tag}`, canonicalHotelId: hotelId, canonicalRoomTypeId: room.id, boardBasisId: board.id,
          checkIn: new Date('2099-07-01'), checkOut: new Date('2099-07-03'), rooms: 1, currency: 'AED', sellAmountMinor: amount, idempotencyKey: `${suffix}-bf-${tag}`,
          requestFingerprint: 'f'.repeat(64), requestId: 'r', createdByUserId: userIds[0], status: 'CONFIRMED', expiresAt: new Date(Date.now() + 3_600_000),
        } })
        return { plan: plan.id, hold: hold.id }
      }
      const ok = await mk(tenantA, s1, hotelA, 'ok'); planS1 = ok.plan; holdOk = ok.hold
      holdDup = (await mk(tenantA, s2, hotelA, 'dup')).hold
      holdMismatch = (await mk(tenantA, s2, hotelA, 'mismatch', 111n)).hold
      holdMutation = (await mk(tenantA, s2, hotelA, 'mut')).hold
      holdForeign = (await mk(tenantB, sB, hotelB, 'foreign')).hold
      const old = (label: string, over: Record<string, unknown>) => fixtureBooking(label, { tenantId: tenantA, supplierId: null, hotelId: hotelA, createdAt: new Date('2098-01-01T00:00:00.000Z'), checkIn: '2099-07-01', rooms: [], total: 777000n, ...over } as never)
      legacy.ok = (await old('legacy-ok', { snapshot: { inventoryHoldId: holdOk } })).id
      legacy.manual = (await old('legacy-manual', { channel: 'MANUAL' })).id
      legacy.nohold = (await old('legacy-nohold', {})).id
      legacy.dup1 = (await old('legacy-dup1', { snapshot: { inventoryHoldId: holdDup } })).id
      legacy.dup2 = (await old('legacy-dup2', { snapshot: { inventoryHoldId: holdDup } })).id
      legacy.mismatch = (await old('legacy-mismatch', { snapshot: { inventoryHoldId: holdMismatch } })).id
      legacy.foreign = (await old('legacy-foreign', { snapshot: { inventoryHoldId: holdForeign } })).id
      legacy.ghost = (await old('legacy-ghost', { snapshot: { inventoryHoldId: 'no-such-hold' } })).id
      legacy.mutation = (await old('legacy-mutation', { snapshot: { inventoryHoldId: holdMutation } })).id
      const otherHold = (await mk(tenantA, s2, hotelA, 'mut-other')).hold
      await owner.supplierMutation.create({ data: { tenantId: tenantA, bookingId: legacy.mutation, holdId: otherHold, supplierKey: 'k', operation: 'PREBOOK', idempotencyKey: `${suffix}-m`, requestId: 'r', status: 'RESOLVED', requestFingerprint: 'f'.repeat(64) } })
    }, 60_000)

    it('dry run reports every category, writes nothing and reconciles', async () => {
      const report = await runBookingSupplierBackfill(owner, { apply: false, tenantIds: [tenantA] })
      const a = report.tenants[0]
      expect(report.mode).toBe('dry-run')
      expect(report.reconciliation).toMatchObject({ categoriesSumToTotal: true, appliedEqualsAttributable: true })
      expect(a.applied).toBe(0)
      expect(a.counts).toMatchObject({
        attributable: 1,
        skip_non_portal_channel: 2, // legacy-manual and the earlier 'connector' fixture
        skip_hold_referenced_by_multiple_bookings: 2,
        skip_hold_disagrees_with_booking: 1,
        skip_hold_not_found_in_tenant: 2, // cross-tenant hold id and a ghost id
        skip_supplier_mutation_hold_conflict: 1,
      })
      expect(a.samples.skip_hold_referenced_by_multiple_bookings?.sort()).toEqual([legacy.dup1, legacy.dup2].sort())
      expect((await owner.booking.findUniqueOrThrow({ where: { id: legacy.ok }, select: { supplierId: true } })).supplierId).toBeNull()
    })

    it('apply attributes only the uniquely attributable booking and leaves every ambiguous one null', async () => {
      const report = await runBookingSupplierBackfill(owner, { apply: true, tenantIds: [tenantA] })
      expect(report.tenants[0].applied).toBe(1)
      expect(report.reconciliation).toMatchObject({ categoriesSumToTotal: true, appliedEqualsAttributable: true })
      const rows = await owner.booking.findMany({ where: { id: { in: Object.values(legacy) } }, select: { id: true, supplierId: true } })
      const owned = Object.fromEntries(rows.map((r) => [r.id, r.supplierId]))
      expect(owned[legacy.ok]).toBe(s1)
      for (const key of ['manual', 'nohold', 'dup1', 'dup2', 'mismatch', 'foreign', 'ghost', 'mutation']) expect({ key, supplierId: owned[legacy[key]] }).toEqual({ key, supplierId: null })
      expect(planS1).not.toBe('')
    })

    it('is idempotent, does not rewrite attributed bookings, and attributed rows stay immutable', async () => {
      const again = await runBookingSupplierBackfill(owner, { apply: true, tenantIds: [tenantA] })
      expect(again.tenants[0].applied).toBe(0)
      expect(again.tenants[0].counts.attributable).toBe(0)
      await expect(owner.booking.update({ where: { id: legacy.ok }, data: { supplierId: s2 } })).rejects.toThrow(/immutable/)
    })

    it('shows the newly attributed booking to its supplier and to no other organization', async () => {
      const cookie1 = await login('s1'); const cookie2 = await login('s2')
      await get(cookie1, tenantA, `/bookings/${legacy.ok}`).expect(200)
      await get(cookie2, tenantA, `/bookings/${legacy.ok}`).expect(404)
      const list2 = await get(cookie2, tenantA, '/bookings?limit=50').expect(200)
      expect(list2.body.data.bookings.map((b: { id: string }) => b.id)).not.toContain(legacy.ok)
    })
  })
})
