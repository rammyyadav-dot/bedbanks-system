import { mkdirSync, writeFileSync } from 'fs'
import { PrismaClient, type Prisma } from '@prisma/client'

/**
 * Proves the existing disposable NOLOGIN role `fbeds_rls_test` is subject to
 * forced RLS. It is not an API connection role: the HTTP runtime still has no
 * provisioned LOGIN role, so this file does not certify the booted API.
 */
describe('disposable RLS role hotel isolation', () => {
  const prisma = new PrismaClient()
  const suffix = `rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const slugA = `${suffix}-a`
  const slugB = `${suffix}-b`

  beforeAll(async () => {
    await prisma.$connect()
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_rls_test') THEN CREATE ROLE fbeds_rls_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;`)
    await prisma.$executeRawUnsafe('GRANT fbeds_rls_test TO CURRENT_USER')
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fbeds_rls_test')
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Hotel", "DailyRate", "Contract", "Supplier" TO fbeds_rls_test')
  })

  afterAll(async () => {
    await prisma.hotel.deleteMany({ where: { name: { startsWith: suffix } } })
    await prisma.tenant.deleteMany({ where: { slug: { in: [slugA, slugB] } } })
    await prisma.$disconnect()
  })

  async function asRole<T>(tenantId: string | null, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
      if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      const [who] = await tx.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
      if (who?.current_user !== 'fbeds_rls_test') throw new Error(`expected fbeds_rls_test, connected as ${who?.current_user ?? 'unknown'}`)
      return work(tx)
    })
  }

  it('isolates hotel rows for the non-bypass role and records why HTTP runtime RLS is not certified', async () => {
    const connection = await prisma.$queryRawUnsafe<Array<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT r.rolname AS role_name, r.rolsuper, r.rolbypassrls, r.rolcanlogin
         FROM pg_roles r WHERE r.rolname = current_user`)
    const restricted = await prisma.$queryRawUnsafe<Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; owned: number }>>(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = r.rolname) AS owned
         FROM pg_roles r WHERE r.rolname = 'fbeds_rls_test'`)
    const tables = await prisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('Hotel', 'DailyRate', 'Contract', 'Supplier')
        ORDER BY c.relname`)
    const loginRoles = await prisma.$queryRawUnsafe<Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND rolname <> 'postgres'
        ORDER BY rolname`)
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/rls-runtime-role.json', JSON.stringify({
      connectionRole: connection[0],
      restrictedRole: restricted[0],
      tables,
      nonBypassLoginRoles: loginRoles,
      httpRuntimeCertification: 'BLOCKED',
      reason: 'The API connects as the database owner. fbeds_rls_test is NOLOGIN and is only assumed with SET LOCAL ROLE. No disposable LOGIN runtime role is provisioned for hotel search.',
    }, null, 2))

    expect(restricted[0]).toMatchObject({ rolname: 'fbeds_rls_test', rolsuper: false, rolbypassrls: false, rolcanlogin: false, owned: 0 })
    for (const table of tables) {
      expect(table.relrowsecurity).toBe(true)
      expect(table.relforcerowsecurity).toBe(true)
      expect(table.owner).not.toBe('fbeds_rls_test')
    }

    const tenantA = await prisma.tenant.create({ data: { name: slugA, slug: slugA } })
    const tenantB = await prisma.tenant.create({ data: { name: slugB, slug: slugB } })
    const hotelA = await prisma.hotel.create({ data: { tenantId: tenantA.id, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    const hotelB = await prisma.hotel.create({ data: { tenantId: tenantB.id, name: `${suffix} B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })

    const visible = await asRole(tenantA.id, (tx) => tx.hotel.findMany({ where: { name: { startsWith: suffix } } }))
    expect(visible.map((hotel) => hotel.id)).toEqual([hotelA.id])
    expect(await asRole(null, (tx) => tx.hotel.findMany({ where: { name: { startsWith: suffix } } }))).toEqual([])
    expect(await asRole(tenantA.id, (tx) => tx.hotel.updateMany({ where: { id: hotelB.id }, data: { name: `${suffix} stolen` } }))).toEqual({ count: 0 })
    await expect(asRole(tenantA.id, (tx) => tx.hotel.create({
      data: { tenantId: tenantB.id, name: `${suffix} forged`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' },
    }))).rejects.toThrow()
    expect(await prisma.hotel.findUnique({ where: { id: hotelB.id } })).toMatchObject({ name: `${suffix} B` })
  })
})
