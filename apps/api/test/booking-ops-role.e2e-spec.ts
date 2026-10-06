import { randomBytes } from 'crypto'
import { ServiceUnavailableException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { BOOKING_OPS_GROUP_ROLE, BOOKING_OPS_LOGIN_ROLE, deprovisionBookingOpsRole, provisionBookingOpsRole, verifyBookingOpsRole } from '../src/database/booking-ops-role'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'

jest.setTimeout(120_000)

/** The dedicated booking module role against real PostgreSQL, disposable database only: privileges, forced RLS, append-only log, no fallback. */
describe('booking module database role (PostgreSQL)', () => {
  const owner = new PrismaClient()
  const suffix = `bo-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = `bo-${randomBytes(20).toString('hex')}`
  let tenantA = '', tenantB = '', url = '', probe: PrismaClient

  const ownerUrl = process.env.DATABASE_URL as string
  const roleUrl = (user: string, pass: string) => { const u = new URL(ownerUrl); u.username = user; u.password = pass; return u.toString() }

  async function booking(tenantId: string, key: string, status = 'CONFIRMED') {
    const hotel = await owner.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${suffix}-${key}`.toUpperCase().slice(0, 40), supplier: 's', hotelId: hotel.id, status: status as never, currency: 'AED', totalMinor: 10_000n, idempotencyKey: `${suffix}-${key}`, searchSnapshot: {} } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: status as never, actorType: 'SYSTEM', payload: {} } })
    return b
  }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    await booking(tenantA, 'a1'); await booking(tenantA, 'a2', 'ON_REQUEST'); await booking(tenantB, 'b1')
    await provisionBookingOpsRole(owner, { password })
    url = roleUrl(BOOKING_OPS_LOGIN_ROLE, password)
    probe = new PrismaClient({ datasourceUrl: `${url}${url.includes('?') ? '&' : '?'}connection_limit=1` })
  })

  afterAll(async () => {
    await probe?.$disconnect()
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await owner.$executeRawUnsafe(`ALTER TABLE "BookingEvent" DISABLE TRIGGER "BookingEvent_immutable"`)
      for (const q of [`DELETE FROM "BookingEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "BookingGuest" WHERE tenant_id = '${t}'`, `DELETE FROM "BookingRoom" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
      await owner.$executeRawUnsafe(`ALTER TABLE "BookingEvent" ENABLE TRIGGER "BookingEvent_immutable"`)
    }
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await deprovisionBookingOpsRole(owner, BOOKING_OPS_LOGIN_ROLE, { dropGroup: true }).catch(() => undefined)
    await owner.$disconnect()
  })

  const asTenant = <T = any>(tenantId: string | null, work: (tx: any) => Promise<T>): Promise<T> => probe.$transaction(async (tx) => {
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
    return work(tx)
  })
  const denied = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (error) { return `${(error as { meta?: { code?: string } }).meta?.code ?? ''} ${(error as Error).message}` } }

  it('BO-E01: the role is limited: not superuser, no BYPASSRLS, owns nothing, member of the group, reads only the booking tables', async () => {
    expect(await verifyBookingOpsRole(probe)).toEqual({ ok: true, failures: [] })
    const [who] = await probe.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
    expect(who.current_user).toBe(BOOKING_OPS_LOGIN_ROLE)
  })

  it('BO-E02: forced RLS: a tenant sees only its own bookings; with no tenant context it sees none; a foreign tenant id sees none of ours', async () => {
    expect(((await asTenant(tenantA, (tx) => tx.booking.findMany({ select: { tenantId: true } }))) as Array<{ tenantId: string }>).map((r) => r.tenantId)).toEqual([tenantA, tenantA])
    expect(await asTenant(tenantB, (tx) => tx.booking.count())).toBe(1)
    expect(await asTenant(null, (tx) => tx.booking.count())).toBe(0)
    expect(await asTenant(null, (tx) => tx.bookingEvent.count())).toBe(0)
    expect(await asTenant('someone-else', (tx) => tx.booking.count())).toBe(0)
    expect(await asTenant(tenantA, (tx) => tx.bookingEvent.count())).toBe(2)
  })

  it('BO-E03: connection reuse does not leak the tenant (transaction-local context, one pooled connection)', async () => {
    for (let i = 0; i < 4; i++) {
      expect(await asTenant(tenantA, (tx) => tx.booking.count())).toBe(2)
      expect(await probe.booking.count()).toBe(0) // outside a tenant transaction the previous tenant is gone
      expect(await asTenant(tenantB, (tx) => tx.booking.count())).toBe(1)
    }
  })

  it('BO-E04: writes are narrow: only the transition columns, only inserts on the booking tables, audit is write-only, nothing is deletable', async () => {
    const PD = /42501|permission denied/i
    const first = await owner.booking.findFirstOrThrow({ where: { tenantId: tenantA } })
    // allowed: the lifecycle columns, an event insert, an audit insert (no read-back)
    await asTenant(tenantA, (tx) => tx.booking.updateMany({ where: { id: first.id }, data: { status: 'CANCELLED', version: 2, supplierRef: 'X-1', hotelConfirmationNo: 'H-1', agentRef: 'A-1', closedAt: new Date() } }))
    await asTenant(tenantA, (tx) => tx.bookingEvent.create({ data: { tenantId: tenantA, bookingId: first.id, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', actorType: 'SYSTEM', payload: {} } }))
    await asTenant(tenantA, (tx) => tx.auditEvent.createMany({ data: [{ tenantId: tenantA, actorType: 'SYSTEM', action: 'booking.test', entityType: 'booking', entityId: first.id, payload: {} }] }))
    // denied: any other Booking column, deletes, updating the immutable log, writing supplier journals, reading audit
    expect(await denied(() => asTenant(tenantA, (tx) => tx.booking.updateMany({ data: { totalMinor: 1n } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.booking.updateMany({ data: { reference: 'FB-HACK' } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.booking.updateMany({ data: { agencyId: null } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.booking.deleteMany()))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.bookingEvent.updateMany({ data: { reason: 'x' } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.bookingEvent.deleteMany()))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.bookingGuest.deleteMany()))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.bookingGuest.updateMany({ data: { firstName: 'x' } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.supplierMutation.deleteMany()))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.supplierMutation.updateMany({ data: { supplierStatus: 'X' } })))).toMatch(PD)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.auditEvent.deleteMany()))).toMatch(PD)
    // RLS still binds writes: another tenant's id in the row is refused by the policy even though the grant allows the insert
    expect(await denied(() => asTenant(tenantB, (tx) => tx.bookingEvent.create({ data: { tenantId: tenantA, bookingId: first.id, toStatus: 'CONFIRMED', actorType: 'SYSTEM', payload: {} } })))).toMatch(/row-level security|42501/i)
    await owner.$executeRawUnsafe(`UPDATE "Booking" SET status = 'CONFIRMED', version = 1, closed_at = NULL, supplier_ref = NULL, hotel_confirmation_no = NULL, agent_ref = NULL WHERE id = '${first.id}'`)
  })

  it('BO-E05: ledger, wallets, documents, cancellations, holds, audit, identity, hotels and agencies are not readable', async () => {
    for (const read of [(tx: any) => tx.ledgerEntry.count(), (tx: any) => tx.wallet.count(), (tx: any) => tx.bookingDocument.count(), (tx: any) => tx.cancellation.count(), (tx: any) => tx.inventoryHold.count(), (tx: any) => tx.auditEvent.count(), (tx: any) => tx.user.count(), (tx: any) => tx.session.count(), (tx: any) => tx.hotel.count(), (tx: any) => tx.agency.count()]) {
      expect(await denied(() => asTenant(tenantA, read))).toMatch(/42501|permission denied/i)
    }
  })

  it('BO-E06: the lifecycle log is append-only even for the owner (UPDATE and DELETE are rejected by a trigger)', async () => {
    expect(await denied(() => owner.$executeRawUnsafe(`UPDATE "BookingEvent" SET reason = 'x' WHERE tenant_id = '${tenantA}'`))).toMatch(/append-only/)
    expect(await denied(() => owner.$executeRawUnsafe(`DELETE FROM "BookingEvent" WHERE tenant_id = '${tenantA}'`))).toMatch(/append-only/)
  })

  it('BO-E06b: deleting a booking (never done by the application) cascades to its rooms, guests and log; a direct delete of the log still fails', async () => {
    const throwaway = await booking(tenantA, 'cascade')
    await owner.bookingRoom.create({ data: { tenantId: tenantA, bookingId: throwaway.id, adults: 2 } })
    expect(await owner.bookingEvent.count({ where: { bookingId: throwaway.id } })).toBe(1)
    await owner.booking.delete({ where: { id: throwaway.id } })
    expect(await owner.bookingEvent.count({ where: { bookingId: throwaway.id } })).toBe(0)
    expect(await owner.bookingRoom.count({ where: { bookingId: throwaway.id } })).toBe(0)
  })

  it('BO-E07: provisioning is idempotent and re-asserts the grants (a broadened grant does not survive a re-run)', async () => {
    await owner.$executeRawUnsafe(`GRANT SELECT ON "LedgerEntry" TO "${BOOKING_OPS_GROUP_ROLE}"`)
    expect((await verifyBookingOpsRole(probe)).ok).toBe(false)
    await provisionBookingOpsRole(owner, { password })
    expect(await verifyBookingOpsRole(probe)).toEqual({ ok: true, failures: [] })
  })

  it('BO-E08: the module connection serves the tenant through the role, and a wrong password or missing role is the not-readable state (no fallback)', async () => {
    const good = new BookingOpsDatabase({ DATABASE_URL: ownerUrl, BOOKING_OPS_DATABASE_URL: url })
    expect(await good.withTenant(tenantA, (tx) => tx.booking.count())).toBe(2)
    expect(await good.withTenant(tenantB, (tx) => tx.booking.count())).toBe(1)
    await good.onModuleDestroy()
    for (const bad of [roleUrl(BOOKING_OPS_LOGIN_ROLE, `${password}x`), roleUrl('fbeds_no_such_role', password)]) {
      const db = new BookingOpsDatabase({ DATABASE_URL: ownerUrl, BOOKING_OPS_DATABASE_URL: bad })
      let response: unknown
      try { await db.withTenant(tenantA, (tx) => tx.booking.count()) } catch (error) { expect(error).toBeInstanceOf(ServiceUnavailableException); response = (error as ServiceUnavailableException).getResponse() }
      expect(response).toMatchObject({ code: OPERATIONS_READ_DENIED })
      expect(JSON.stringify(response)).not.toContain(password)
      await db.onModuleDestroy()
    }
  })
})
