import { randomBytes } from 'crypto'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { HOLD_EXPIRY_GROUP_ROLE, provisionHoldExpiryRole, verifyHoldExpiryRole } from '../src/database/hold-expiry-role'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { HoldExpirySweeper } from '../src/agent/hold-expiry-sweeper.service'
import { InventoryAdminService } from '../src/inventory/inventory-admin.service'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * Inventory pool tables under the real restricted login roles (never a superuser, never BYPASSRLS):
 * the API runtime role and the hold-expiry worker role. The owner connection is used only to provision and to build fixtures.
 */
describe('inventory pool tables under the restricted runtime roles (PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `rr-${Date.now()}-${randomBytes(3).toString('hex')}`
  const apiPassword = randomBytes(24).toString('hex'); const holdPassword = randomBytes(24).toString('hex')
  const HOLD_LOGIN = 'fbeds_hold_expiry_login'
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const D1 = day(40), D2 = day(41)
  let ownerRole = ''
  let api: PrismaService, apiSingle: PrismaService, hold: PrismaService
  const T: Record<'A' | 'B', { tenant: string; user: string; supplier: string; hotel: string; room: string; board: string; plan: string; pool: string; poolDays: string[] }> = { A: {} as never, B: {} as never }

  const urlFor = (role: string, password: string, extra = '') => { const u = new URL(ownerUrl!); u.username = role; u.password = password; return `${u.toString()}${extra}` }
  const code = async (work: () => Promise<unknown>): Promise<string> => { try { await work(); return 'OK' } catch (e) { const m = e instanceof Error ? e.message : ''; return /42501|permission denied/i.test(m) ? '42501' : /23503|foreign key/i.test(m) ? '23503' : /row-level security|42501/i.test(m) ? 'RLS' : /23514|check/i.test(m) ? '23514' : /P2025|not found|No .* found/i.test(m) ? 'NOT_FOUND' : `ERR:${m.slice(0, 80)}` } }

  async function fixture(key: 'A' | 'B') {
    const tenant = (await owner.tenant.create({ data: { name: `${suffix}${key}`, slug: `${suffix}${key}` } })).id
    const user = (await owner.user.create({ data: { email: `${suffix}${key}@example.test` } })).id
    const supplier = (await owner.supplier.create({ data: { tenantId: tenant, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix}${key}`, displayName: key, countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const hotel = (await owner.hotel.create({ data: { tenantId: tenant, name: `${suffix}${key} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    const room = (await owner.roomType.create({ data: { hotelId: hotel, name: 'Room', code: `${suffix}${key}`, maxAdults: 2, maxOccupancy: 2 } })).id
    const board = (await owner.boardBasis.create({ data: { tenantId: tenant, code: `B${key}`, name: `B ${suffix}${key}` } })).id
    const mapping = (await owner.supplierHotelMapping.create({ data: { tenantId: tenant, supplierId: supplier, hotelId: hotel, supplierHotelId: `${suffix}${key}`, status: 'MAPPED' } })).id
    const contract = (await owner.contract.create({ data: { tenantId: tenant, supplierId: supplier, supplierHotelMappingId: mapping, code: `${suffix}${key}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    const pool = (await owner.inventoryPool.create({ data: { tenantId: tenant, hotelId: hotel, supplierId: supplier, name: `Pool ${key}`, createdById: user } })).id
    const plan = (await owner.ratePlan.create({ data: { tenantId: tenant, contractId: contract, roomTypeId: room, boardBasisId: board, code: `P${key}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', inventoryPoolId: pool } })).id
    const poolDays: string[] = []
    for (const d of [D1, D2]) {
      poolDays.push((await owner.inventoryPoolDay.create({ data: { tenantId: tenant, poolId: pool, stayDate: new Date(d), capacity: 5 } })).id)
      await owner.dailyAvailability.create({ data: { tenantId: tenant, ratePlanId: plan, stayDate: new Date(d), allotment: 9 } })
    }
    T[key] = { tenant, user, supplier, hotel, room, board, plan, pool, poolDays }
  }

  beforeAll(async () => {
    await owner.$connect()
    ownerRole = (await owner.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user'))[0].current_user // whoever owns the schema in this environment
    await provisionApiRuntimeRole(owner, { password: apiPassword })
    await provisionHoldExpiryRole(owner, { loginRole: HOLD_LOGIN, password: holdPassword })
    api = new PrismaService({ datasourceUrl: urlFor(API_RUNTIME_LOGIN_ROLE, apiPassword) } as never)
    apiSingle = new PrismaService({ datasourceUrl: urlFor(API_RUNTIME_LOGIN_ROLE, apiPassword, '&connection_limit=1') } as never)
    hold = new PrismaService({ datasourceUrl: urlFor(HOLD_LOGIN, holdPassword) } as never)
    await Promise.all([api.$connect(), apiSingle.$connect(), hold.$connect()])
    await fixture('A'); await fixture('B')
  })

  afterAll(async () => {
    await Promise.all([api?.$disconnect(), apiSingle?.$disconnect(), hold?.$disconnect()])
    for (const k of ['A', 'B'] as const) {
      const t = T[k]?.tenant; if (!t) continue
      await owner.auditEvent.deleteMany({ where: { tenantId: t } }); await owner.inventoryHoldNight.deleteMany({ where: { tenantId: t } }); await owner.inventoryHold.deleteMany({ where: { tenantId: t } })
      await owner.dailyAvailability.deleteMany({ where: { tenantId: t } }); await owner.ratePlan.deleteMany({ where: { tenantId: t } })
      await owner.inventoryPoolDay.deleteMany({ where: { tenantId: t } }); await owner.inventoryPool.deleteMany({ where: { tenantId: t } })
      await owner.contract.deleteMany({ where: { tenantId: t } }); await owner.supplierHotelMapping.deleteMany({ where: { tenantId: t } }); await owner.boardBasis.deleteMany({ where: { tenantId: t } })
      await owner.roomType.deleteMany({ where: { hotel: { tenantId: t } } }); await owner.hotel.deleteMany({ where: { tenantId: t } }); await owner.supplier.deleteMany({ where: { tenantId: t } })
      await owner.user.deleteMany({ where: { id: T[k].user } }); await owner.tenant.deleteMany({ where: { id: t } })
    }
    await owner.$disconnect()
  })

  describe('API runtime role', () => {
    it('RR-01 has no elevated attribute, owns nothing, is in no other role, and passes the repository verifier', async () => {
      expect(await verifyApiRuntimeRole(api)).toEqual({ ok: true, failures: [] })
      const [attrs] = await api.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; owned: bigint; owned_other: bigint }>>(
        `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
                (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user) AS owned,
                (SELECT count(*) FROM pg_database d WHERE pg_get_userbyid(d.datdba) = current_user) AS owned_other
           FROM pg_roles r WHERE r.rolname = current_user`)
      expect(attrs).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false })
      expect(Number(attrs.owned) + Number(attrs.owned_other)).toBe(0)
      const memberships = await api.$queryRawUnsafe<Array<{ role: string }>>(`SELECT pg_get_userbyid(roleid) AS role FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)
      expect(memberships.map((m) => m.role)).toEqual(['fbeds_api'])
    })

    it('RR-01b a migration-style over-grant of pool writes (role existed before the migration) is detected by the verifier and removed by re-provisioning', async () => {
      await owner.$executeRawUnsafe('GRANT INSERT, UPDATE ON "InventoryPool" TO fbeds_api')
      const dirty = await verifyApiRuntimeRole(api)
      expect(dirty.ok).toBe(false); expect(dirty.failures.join(' ')).toMatch(/inventory pool tables/)
      await provisionApiRuntimeRole(owner, { password: apiPassword })
      expect(await verifyApiRuntimeRole(api)).toEqual({ ok: true, failures: [] })
    })

    it('RR-02 cannot run DDL, create roles, grant itself anything, or become another role', async () => {
      for (const sql of ['CREATE TABLE rr_probe (id int)', 'ALTER TABLE "InventoryPool" DISABLE ROW LEVEL SECURITY', 'ALTER TABLE "InventoryPoolDay" NO FORCE ROW LEVEL SECURITY', 'DROP POLICY "InventoryPool_tenant_isolation" ON "InventoryPool"',
        'DROP TABLE "InventoryPoolDay"', 'CREATE ROLE rr_escalate LOGIN', `SET ROLE "${ownerRole}"`, 'CREATE TRIGGER rr_t BEFORE INSERT ON "InventoryPool" FOR EACH ROW EXECUTE FUNCTION fbeds_inventory_pool_tenant_guard()']) {
        expect([sql, await code(() => api.$executeRawUnsafe(sql))]).toEqual([sql, expect.stringMatching(/^(42501|ERR:.*(must be owner|permission denied|cannot|no privilege))/i)])
      }
      expect((await api.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_roles WHERE rolname = 'rr_escalate'`))[0].n).toBe(0n)
      // PostgreSQL answers an unauthorised GRANT with a warning, not an error: prove the privilege did not change.
      await api.$executeRawUnsafe('GRANT DELETE ON "InventoryPool" TO fbeds_api')
      expect((await api.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_table_privilege('fbeds_api', '"InventoryPool"', 'DELETE') AS ok`))[0].ok).toBe(false)
    })

    it('RR-03 own tenant: pool and pool-day rows are readable; the other tenant is invisible; no context shows nothing', async () => {
      const own = await api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.findMany({ where: {}, select: { tenantId: true, id: true } }))
      expect(own.length).toBe(2); expect(own.every((r) => r.tenantId === T.A.tenant)).toBe(true)
      const pools = await api.withTenant(T.B.tenant, (tx) => tx.inventoryPool.findMany({ select: { id: true, tenantId: true } }))
      expect(pools.map((p) => p.id)).toEqual([T.B.pool])
      expect(await api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.count({ where: { tenantId: T.B.tenant } }))).toBe(0) // asking for the other tenant by filter still yields nothing
      expect(await api.inventoryPool.count()).toBe(0) // no tenant context: the policy returns no rows
      expect(await api.inventoryPoolDay.count()).toBe(0)
    })

    it('RR-04 every pool write by the API role is refused by privilege, and the other tenant is untouched', async () => {
      const mk = (tenantId: string, poolId: string, stayDate: string) => ({ data: { tenantId, poolId, stayDate: new Date(stayDate), capacity: 3 } })
      for (const attempt of [
        () => api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.create(mk(T.B.tenant, T.B.pool, day(60)))),
        () => api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.create(mk(T.A.tenant, T.B.pool, day(61)))),
        () => api.withTenant(T.A.tenant, (tx) => tx.inventoryPool.create({ data: { tenantId: T.A.tenant, hotelId: T.B.hotel, supplierId: T.B.supplier, name: 'x2', createdById: T.A.user } })),
        () => api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.updateMany({ where: { id: T.B.poolDays[0] }, data: { capacity: 99 } })),
        () => api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.updateMany({ where: { id: T.A.poolDays[0] }, data: { tenantId: T.B.tenant } })),
      ]) expect(await code(attempt)).toBe('42501')
      expect((await owner.inventoryPoolDay.findMany({ where: { poolId: T.B.pool } })).every((d) => d.capacity === 5 && d.tenantId === T.B.tenant)).toBe(true)
      expect(await owner.inventoryPoolDay.count({ where: { stayDate: { in: [new Date(day(60)), new Date(day(61))] } } })).toBe(0)
    })

    it('RR-04b row-level security and the composite keys refuse cross-tenant pool writes even for a NOBYPASSRLS role that DOES hold write grants (defence in depth)', async () => {
      await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_rls_test') THEN CREATE ROLE fbeds_rls_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`)
      await owner.$executeRawUnsafe('GRANT fbeds_rls_test TO CURRENT_USER')
      await owner.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fbeds_rls_test')
      await owner.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE ON "InventoryPool", "InventoryPoolDay" TO fbeds_rls_test')
      await owner.$executeRawUnsafe('GRANT SELECT ON "Hotel", "Supplier", "tenants" TO fbeds_rls_test')
      const asRole = <R>(tenantId: string | null, work: (tx: Prisma.TransactionClient) => Promise<R>) => owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
        if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
        const [who] = await tx.$queryRawUnsafe<Array<{ current_user: string; rolbypassrls: boolean }>>('SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls')
        expect(who).toEqual({ current_user: 'fbeds_rls_test', rolbypassrls: false })
        return work(tx)
      })
      const mk = (tenantId: string, poolId: string, stayDate: string) => ({ data: { tenantId, poolId, stayDate: new Date(stayDate), capacity: 3 } })
      expect(await code(() => asRole(T.A.tenant, (tx) => tx.inventoryPoolDay.create(mk(T.B.tenant, T.B.pool, day(60)))))).toBe('42501') // WITH CHECK
      expect(await code(() => asRole(T.A.tenant, (tx) => tx.inventoryPoolDay.create(mk(T.A.tenant, T.B.pool, day(61)))))).not.toBe('OK') // composite (tenant, pool) key
      expect(await code(() => asRole(T.A.tenant, (tx) => tx.inventoryPool.create({ data: { tenantId: T.A.tenant, hotelId: T.B.hotel, supplierId: T.B.supplier, name: 'x', createdById: T.A.user } })))).not.toBe('OK') // tenant guard trigger
      expect((await asRole(T.A.tenant, (tx) => tx.inventoryPoolDay.updateMany({ where: { id: T.B.poolDays[0] }, data: { capacity: 99 } }))).count).toBe(0)
      expect(await code(() => asRole(T.A.tenant, (tx) => tx.inventoryPoolDay.updateMany({ where: { id: T.A.poolDays[0] }, data: { tenantId: T.B.tenant } })))).toBe('42501')
      expect(await asRole(null, (tx) => tx.inventoryPoolDay.count())).toBe(0)
      const own = await asRole(T.A.tenant, (tx) => tx.inventoryPoolDay.create(mk(T.A.tenant, T.A.pool, day(62)))) // the policy admits the owning tenant
      expect(own.tenantId).toBe(T.A.tenant)
      await owner.inventoryPoolDay.delete({ where: { id: own.id } })
      expect(await owner.inventoryPoolDay.count({ where: { stayDate: { in: [new Date(day(60)), new Date(day(61))] } } })).toBe(0)
    })

    it('RR-05 unauthorized mutations fail with a privilege error: delete pools, write stock rows, change plans, move holds', async () => {
      expect(await code(() => api.withTenant(T.A.tenant, (tx) => tx.inventoryPool.deleteMany({})))).toBe('42501')
      expect(await code(() => api.withTenant(T.A.tenant, (tx) => tx.inventoryPoolDay.deleteMany({})))).toBe('42501')
      expect(await code(() => api.withTenant(T.A.tenant, (tx) => tx.dailyAvailability.updateMany({ data: { held: 1 } })))).toBe('42501')
      expect(await code(() => api.withTenant(T.A.tenant, (tx) => tx.ratePlan.updateMany({ data: { inventoryPoolId: null } })))).toBe('42501')
      expect(await code(() => api.withTenant(T.A.tenant, (tx) => tx.inventoryHold.findMany()))).toBe('42501')
      expect(await owner.inventoryPoolDay.count({ where: { tenantId: T.A.tenant } })).toBe(2)
      expect((await owner.ratePlan.findUniqueOrThrow({ where: { id: T.A.plan } })).inventoryPoolId).toBe(T.A.pool)
    })

    it('RR-06 a pooled-inventory Admin mutation through the service fails closed under this role and writes nothing', async () => {
      const service = new InventoryAdminService(api)
      const before = await owner.inventoryPool.count({ where: { tenantId: T.A.tenant } })
      const outcome = await service.createPool(T.A.tenant, T.A.user, T.A.hotel, { name: 'Runtime attempt', supplierId: T.A.supplier, ratePlanIds: [], idempotencyKey: `${suffix}-rt-create` }, null).then(() => 'created', (e: Error) => (/42501|permission denied/i.test(e.message) ? 'refused-by-privilege' : `refused:${e.message.slice(0, 60)}`))
      expect(await owner.inventoryPool.count({ where: { tenantId: T.A.tenant } })).toBe(before)
      expect(outcome).toBe('refused-by-privilege') // nothing but the missing grant can refuse this request; the read side still works:
      const summary = await service.summary(T.A.tenant, T.A.hotel, { from: D1, days: 2 })
      expect(summary.pools[0].nights.map((n) => n.capacity)).toEqual([5, 5])
      await expect(service.summary(T.B.tenant, T.A.hotel, {})).rejects.toThrow(/not found/i)
    })

    it('RR-07 connection reuse never leaks tenant context (one pooled connection, alternating tenants, an aborted transaction, no context)', async () => {
      const probe = () => apiSingle.$queryRawUnsafe<Array<{ ctx: string | null; n: bigint }>>(`SELECT current_setting('app.current_tenant_id', true) AS ctx, (SELECT count(*) FROM "InventoryPoolDay") AS n`)
      const a1 = await apiSingle.withTenant(T.A.tenant, async (tx) => (await tx.inventoryPoolDay.findMany({ select: { tenantId: true } })).map((r) => r.tenantId))
      expect(new Set(a1)).toEqual(new Set([T.A.tenant]))
      const after = await probe(); expect([after[0].ctx ?? '', Number(after[0].n)]).toEqual(['', 0])
      await expect(apiSingle.withTenant(T.B.tenant, async () => { throw new Error('boom') })).rejects.toThrow('boom')
      const afterAbort = await probe(); expect([afterAbort[0].ctx ?? '', Number(afterAbort[0].n)]).toEqual(['', 0])
      const b = await apiSingle.withTenant(T.B.tenant, async (tx) => (await tx.inventoryPoolDay.findMany({ select: { tenantId: true } })).map((r) => r.tenantId))
      expect(new Set(b)).toEqual(new Set([T.B.tenant]))
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => apiSingle.withTenant(i % 2 ? T.A.tenant : T.B.tenant, async (tx) => ({ want: i % 2 ? T.A.tenant : T.B.tenant, got: [...new Set((await tx.inventoryPoolDay.findMany({ select: { tenantId: true } })).map((r) => r.tenantId))] }))))
      for (const r of results) expect(r.got).toEqual([r.want])
    })
  })

  describe('hold-expiry worker role', () => {
    it('HR-01 passes its verifier, has no elevated attribute, owns nothing and sits in one group', async () => {
      expect(await verifyHoldExpiryRole(hold)).toEqual({ ok: true, failures: [] })
      const [a] = await hold.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; owned: bigint }>>(`SELECT r.rolsuper, r.rolbypassrls, (SELECT count(*) FROM pg_class c WHERE pg_get_userbyid(c.relowner) = current_user) AS owned FROM pg_roles r WHERE r.rolname = current_user`)
      expect(a).toMatchObject({ rolsuper: false, rolbypassrls: false }); expect(Number(a.owned)).toBe(0)
      const memberships = await hold.$queryRawUnsafe<Array<{ role: string }>>(`SELECT pg_get_userbyid(roleid) AS role FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)
      expect(memberships.map((m) => m.role)).toEqual([HOLD_EXPIRY_GROUP_ROLE])
    })

    it('HR-02 privilege surface is exactly the expiry operation: stock columns held/updated_at only; nothing else', async () => {
      const priv = (table: string, p: string) => hold.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_table_privilege(current_user, '"${table}"', '${p}') AS ok`).then((r) => r[0].ok)
      const col = (table: string, column: string, p: string) => hold.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_column_privilege(current_user, '"${table}"', '${column}', '${p}') AS ok`).then((r) => r[0].ok)
      expect(await priv('InventoryPoolDay', 'SELECT')).toBe(true)
      expect(await col('InventoryPoolDay', 'held', 'UPDATE')).toBe(true)
      for (const c of ['capacity', 'sold', 'tenant_id', 'pool_id', 'stay_date', 'source', 'fresh_until']) expect([c, await col('InventoryPoolDay', c, 'UPDATE')]).toEqual([c, false])
      for (const p of ['INSERT', 'DELETE', 'TRUNCATE']) expect([p, await priv('InventoryPoolDay', p)]).toEqual([p, false])
      for (const table of ['InventoryPool', 'RatePlan', 'Hotel', 'Contract', 'DailyRate', 'Booking', 'Wallet', 'LedgerEntry', 'users', 'sessions']) expect([table, await priv(table, 'SELECT')]).toEqual([table, false])
      for (const p of ['INSERT', 'DELETE']) expect([p, await priv('DailyAvailability', p), await priv('InventoryHoldNight', p)]).toEqual([p, false, false])
      expect(await col('DailyAvailability', 'allotment', 'UPDATE')).toBe(false)
      expect(await col('DailyAvailability', 'held', 'UPDATE')).toBe(true)
    })

    it('HR-03 cross-tenant design: it sees tenants but acts on pool days only inside one tenant context; no context and a foreign context act on nothing', async () => {
      expect((await hold.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM tenants WHERE id IN ('${T.A.tenant}', '${T.B.tenant}')`))[0].n).toBe(2n) // tenant enumeration is intended (id, status only)
      expect(await code(() => hold.$queryRawUnsafe(`SELECT slug FROM tenants LIMIT 1`))).toBe('42501') // ... and only those two columns
      expect(await hold.inventoryPoolDay.count()).toBe(0) // no context: nothing
      const foreign = await hold.withTenant(T.A.tenant, (tx) => tx.$executeRawUnsafe(`UPDATE "InventoryPoolDay" SET "held" = "held" + 0 WHERE "id" = '${T.B.poolDays[0]}'`))
      expect(foreign).toBe(0)
      const own = await hold.withTenant(T.A.tenant, (tx) => tx.$executeRawUnsafe(`UPDATE "InventoryPoolDay" SET "held" = "held" + 0 WHERE "id" = '${T.A.poolDays[0]}'`))
      expect(own).toBe(1)
      expect(await code(() => hold.withTenant(T.A.tenant, (tx) => tx.$executeRawUnsafe(`UPDATE "InventoryPoolDay" SET "capacity" = 99 WHERE "id" = '${T.A.poolDays[0]}'`)))).toBe('42501')
      expect(await code(() => hold.withTenant(T.A.tenant, (tx) => tx.$executeRawUnsafe(`UPDATE "InventoryPoolDay" SET "tenant_id" = '${T.B.tenant}' WHERE "id" = '${T.A.poolDays[0]}'`)))).toBe('42501')
    })

    it('HR-04 the sweeper, on this role only, expires due holds in two tenants, returns each unit to its own pool day exactly once, and audits as SYSTEM', async () => {
      const holds = new InventoryHoldService(owner)
      const make = async (k: 'A' | 'B') => holds.create({ tenantId: T[k].tenant, userId: T[k].user, requestId: `r-${k}`, idempotencyKey: `${suffix}-sweep-${k}`, offerId: 'o', searchId: 's', ratePlanId: T[k].plan, canonicalHotelId: T[k].hotel, canonicalRoomTypeId: T[k].room, boardBasisId: T[k].board, checkIn: D1, checkOut: D2, rooms: 2, currency: 'AED', sellAmountMinor: 1000, offerExpiresAt: new Date(Date.now() + 1_500).toISOString() })
      const [ha, hb] = [await make('A'), await make('B')]
      expect((await owner.inventoryPoolDay.findUniqueOrThrow({ where: { id: T.A.poolDays[0] } })).held).toBe(2)
      await new Promise((r) => setTimeout(r, 1_800))
      const sweeper = new HoldExpirySweeper({ HOLD_EXPIRY_SWEEP_ENABLED: 'true', HOLD_EXPIRY_DATABASE_URL: urlFor(HOLD_LOGIN, holdPassword), DATABASE_URL: ownerUrl, HOLD_EXPIRY_SWEEP_INTERVAL_MS: '3600000' })
      await sweeper.onModuleInit()
      try { expect(await sweeper.runOnce()).toBeGreaterThanOrEqual(2); expect(await sweeper.runOnce()).toBe(0) /* second pass finds nothing: exactly once */ } finally { await sweeper.onModuleDestroy() }
      for (const [k, h] of [['A', ha], ['B', hb]] as const) {
        expect((await owner.inventoryHold.findUniqueOrThrow({ where: { id: h.holdId } })).status).toBe('EXPIRED')
        const days = await owner.inventoryPoolDay.findMany({ where: { poolId: T[k].pool }, select: { held: true, sold: true, capacity: true } })
        expect(days).toEqual([{ held: 0, sold: 0, capacity: 5 }, { held: 0, sold: 0, capacity: 5 }])
        const audit = await owner.auditEvent.findMany({ where: { tenantId: T[k].tenant, entityId: h.holdId, action: 'inventory.hold.expired' } })
        expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
      }
      // no other audit action can be forged by this role
      expect(await code(() => hold.withTenant(T.A.tenant, (tx) => tx.auditEvent.create({ data: { tenantId: T.A.tenant, actorType: 'SYSTEM', action: 'booking.confirmed', entityType: 'x', entityId: 'x', payload: {} } })))).toBe('42501')
    })
  })
})
