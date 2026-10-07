import { randomBytes } from 'crypto'
import { ServiceUnavailableException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { BOOKING_OPS_LOGIN_ROLE, provisionBookingOpsRole } from '../src/database/booking-ops-role'
import { PrismaService } from '../src/database/prisma.service'
import { RuntimeRoleViolation, assertRuntimeDbIdentity } from '../src/database/runtime-db-identity'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { HoldExpirySweeper } from '../src/agent/hold-expiry-sweeper.service'

jest.setTimeout(180_000)

/**
 * P0-01 (ADR 0040) against real PostgreSQL roles: the API process refuses to run as the migration owner, a superuser, a BYPASSRLS login, a table owner or
 * a member of a privileged role; and accepts the restricted login. Disposable database only.
 */
describe('runtime database identity guard (PostgreSQL)', () => {
  const owner = new PrismaClient()
  const tag = randomBytes(3).toString('hex')
  const ownerUrl = process.env.DATABASE_URL as string
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const bookingPassword = `bo-${randomBytes(20).toString('hex')}`
  const rolePassword = `p0-${randomBytes(20).toString('hex')}`
  const names = { superuser: `p0s_${tag}_login`, bypass: `p0b_${tag}_login`, owns: `p0t_${tag}_login`, member: `p0m_${tag}_login`, plain: `p0p_${tag}_login` }
  const table = `p0_owned_${tag}`
  const urlFor = (user: string, password: string) => { const u = new URL(ownerUrl); u.username = user; u.password = password; return u.toString() }
  const connect = (user: string, password: string) => new PrismaClient({ datasourceUrl: urlFor(user, password) })
  const previousGuard = process.env.DB_RUNTIME_ROLE_GUARD; const previousUrl = process.env.DATABASE_URL; const previousAdmin = process.env.ADMIN_ORIGIN

  beforeAll(async () => {
    process.env.DB_RUNTIME_ROLE_GUARD = 'enforce'
    await owner.$connect()
    await owner.$executeRawUnsafe(`CREATE ROLE "${names.superuser}" LOGIN SUPERUSER PASSWORD '${rolePassword}'`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${names.bypass}" LOGIN NOSUPERUSER BYPASSRLS PASSWORD '${rolePassword}'`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${names.owns}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${names.member}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${names.plain}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`)
    await owner.$executeRawUnsafe(`GRANT "${names.bypass}" TO "${names.member}"`)
    await owner.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${names.owns}"`)
    await owner.$executeRawUnsafe(`CREATE TABLE public."${table}" (id int)`)
    await owner.$executeRawUnsafe(`ALTER TABLE public."${table}" OWNER TO "${names.owns}"`)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    await provisionBookingOpsRole(owner, { password: bookingPassword })
  })

  afterAll(async () => {
    if (previousGuard === undefined) delete process.env.DB_RUNTIME_ROLE_GUARD; else process.env.DB_RUNTIME_ROLE_GUARD = previousGuard
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    if (previousAdmin === undefined) delete process.env.ADMIN_ORIGIN; else process.env.ADMIN_ORIGIN = previousAdmin
    await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${table}"`).catch(() => undefined)
    for (const name of Object.values(names)) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${name}"`).catch(() => undefined)
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined)
    }
    await owner.$disconnect()
  })

  async function identityFailure(user: string, password: string): Promise<string | null> {
    const client = connect(user, password)
    try { await assertRuntimeDbIdentity(client, 'API'); return null } catch (error) { expect(error).toBeInstanceOf(RuntimeRoleViolation); return (error as Error).message } finally { await client.$disconnect() }
  }

  it('RG-E01: the migration owner / superuser login is refused, naming the invariant and nothing secret', async () => {
    const owner0 = new URL(ownerUrl).username
    const message = await identityFailure(owner0, decodeURIComponent(new URL(ownerUrl).password))
    expect(message).toMatch(/Refusing to run: API database connection violates the runtime role invariant/)
    expect(message).toMatch(/SUPERUSER|BYPASSRLS|owns database objects|known owner/)
    expect(message).not.toContain(rolePassword); expect(message).not.toMatch(/postgres(ql)?:\/\//)
    expect(await identityFailure(names.superuser, rolePassword)).toMatch(/role is SUPERUSER/)
  })

  it('RG-E02: a BYPASSRLS login, a table owner and a member of a privileged role are each refused', async () => {
    expect(await identityFailure(names.bypass, rolePassword)).toMatch(/role has BYPASSRLS/)
    expect(await identityFailure(names.owns, rolePassword)).toMatch(/owns database objects/)
    expect(await identityFailure(names.member, rolePassword)).toMatch(/member of privileged roles: .*_login/)
  })

  it('RG-E03: a restricted login with no privileges of note is accepted; so are the strict API and booking logins, and the API verifier agrees', async () => {
    expect(await identityFailure(names.plain, rolePassword)).toBeNull()
    expect(await identityFailure(API_RUNTIME_LOGIN_ROLE, runtimePassword)).toBeNull()
    expect(await identityFailure(BOOKING_OPS_LOGIN_ROLE, bookingPassword)).toBeNull()
    const api = connect(API_RUNTIME_LOGIN_ROLE, runtimePassword)
    try { expect((await verifyApiRuntimeRole(api)).failures).toEqual([]); expect((await api.$queryRawUnsafe<Array<{ u: string }>>('SELECT current_user::text AS u'))[0].u).toBe(API_RUNTIME_LOGIN_ROLE) } finally { await api.$disconnect() }
  })

  it('RG-E04: PrismaService startup fails closed on the owner URL and succeeds on the restricted URL', async () => {
    const bad = new PrismaService({ datasourceUrl: ownerUrl })
    await expect(bad.onModuleInit()).rejects.toBeInstanceOf(RuntimeRoleViolation)
    const good = new PrismaService({ datasourceUrl: urlFor(API_RUNTIME_LOGIN_ROLE, runtimePassword) })
    await expect(good.onModuleInit()).resolves.toBeUndefined()
    await good.onModuleDestroy()
  })

  it('RG-E05: the whole Nest application refuses to boot when DATABASE_URL is the owner, and boots as the restricted login', async () => {
    process.env.ADMIN_ORIGIN = 'http://localhost:3001'
    process.env.DATABASE_URL = ownerUrl
    const refused = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app1 = refused.createNestApplication()
    await expect(app1.init()).rejects.toBeInstanceOf(RuntimeRoleViolation)
    await app1.close().catch(() => undefined)
    process.env.DATABASE_URL = urlFor(API_RUNTIME_LOGIN_ROLE, runtimePassword)
    const accepted = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app2 = accepted.createNestApplication(); await app2.init()
    try { expect((await app2.get(PrismaService).$queryRawUnsafe<Array<{ u: string }>>('SELECT current_user::text AS u'))[0].u).toBe(API_RUNTIME_LOGIN_ROLE) } finally { await app2.close() }
  })

  it('RG-E06: the booking module connection is refused (sanitized 503, logged) when it is a privileged login, and works as the booking role', async () => {
    const bad = new BookingOpsDatabase({ DATABASE_URL: urlFor(API_RUNTIME_LOGIN_ROLE, runtimePassword), BOOKING_OPS_DATABASE_URL: ownerUrl })
    await expect(bad.withTenant('t', async () => 1)).rejects.toBeInstanceOf(ServiceUnavailableException)
    await bad.onModuleDestroy()
    const good = new BookingOpsDatabase({ DATABASE_URL: ownerUrl, BOOKING_OPS_DATABASE_URL: urlFor(BOOKING_OPS_LOGIN_ROLE, bookingPassword) })
    await expect(good.withTenant('t', async (tx) => (await tx.$queryRawUnsafe<Array<{ u: string }>>('SELECT current_user::text AS u'))[0].u)).resolves.toBe(BOOKING_OPS_LOGIN_ROLE)
    await good.onModuleDestroy()
  })

  it('RG-E07: the hold-expiry sweeper does not start on a privileged credential', async () => {
    const env = { HOLD_EXPIRY_SWEEP_ENABLED: 'true', HOLD_EXPIRY_DATABASE_URL: ownerUrl, DATABASE_URL: 'postgresql://x:y@h/db' } as Record<string, string>
    const sweeper = new HoldExpirySweeper(env)
    await expect(sweeper.onModuleInit()).rejects.toBeInstanceOf(RuntimeRoleViolation)
    await sweeper.onModuleDestroy()
  })
})
