import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE } from '@bedbanks/contracts'
import { BookingTransactionDatabase } from '../src/agent/booking-transaction.database'
import {
  BOOKTX_LOGIN_ROLE, certifyBooktxRole, deprovisionBooktxRole, provisionBooktxRole,
} from '../src/database/booking-transaction-role'

jest.setTimeout(180_000)

/**
 * The Agent booking transaction login against disposable PostgreSQL.
 * Connects as that login for the catalogue, the probes and the trigger rows. Never uses the owner for the mutation under test.
 */
describe('booking transaction database role (PostgreSQL)', () => {
  const ownerUrl = process.env.DATABASE_URL as string
  const owner = new PrismaClient()
  const suffix = `btx-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const password = `btx${randomBytes(24).toString('hex')}`.slice(0, 48)
  let tenantA = ''
  let tenantB = ''
  let agencyA = ''
  let probe: PrismaClient
  let roleUrl = ''

  const roleUrlFor = (user: string, pass: string) => {
    const parsed = new URL(ownerUrl)
    parsed.username = user
    parsed.password = pass
    return parsed.toString()
  }

  beforeAll(async () => {
    if (!ownerUrl) throw new Error('DATABASE_URL must be the disposable owner credential')
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const user = await owner.user.create({ data: { email: `${suffix}@example.test`, name: suffix } })
    agencyA = (await owner.agency.create({ data: { tenantId: tenantA, code: `BTX${randomBytes(4).toString('hex').toUpperCase()}`, name: suffix, createdById: user.id } })).id
    const hotel = await owner.hotel.create({ data: { tenantId: tenantA, name: suffix, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    await owner.booking.create({ data: { tenantId: tenantA, reference: `FB-${suffix}`.toUpperCase().slice(0, 40), supplier: 'contracted', hotelId: hotel.id, currency: 'AED', totalMinor: 10_000n, idempotencyKey: `${suffix}-seed`, searchSnapshot: {} } })
    await provisionBooktxRole(owner, { password })
    roleUrl = roleUrlFor(BOOKTX_LOGIN_ROLE, password)
    probe = new PrismaClient({ datasourceUrl: `${roleUrl}${roleUrl.includes('?') ? '&' : '?'}connection_limit=1` })
    await probe.$connect()
  })

  afterAll(async () => {
    await probe?.$disconnect().catch(() => undefined)
    if (tenantA) {
      await owner.booking.deleteMany({ where: { tenantId: tenantA } }).catch(() => undefined)
      await owner.ledgerEntry.deleteMany({ where: { tenantId: tenantA } }).catch(() => undefined)
      await owner.wallet.deleteMany({ where: { tenantId: tenantA } }).catch(() => undefined)
      await owner.hotel.deleteMany({ where: { tenantId: tenantA } }).catch(() => undefined)
      await owner.agency.deleteMany({ where: { tenantId: tenantA } }).catch(() => undefined)
    }
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } }).catch(() => undefined)
    await deprovisionBooktxRole(owner, BOOKTX_LOGIN_ROLE, { dropGroup: true }).catch(() => undefined)
    await owner.$disconnect()
  })

  const asTenant = <T>(tenantId: string, work: (tx: PrismaClient) => Promise<T>): Promise<T> => probe.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
    return work(tx as unknown as PrismaClient)
  })

  const denied = async (work: () => Promise<unknown>) => {
    try { await work(); return null } catch (error) { return `${(error as { meta?: { code?: string } }).meta?.code ?? ''} ${(error as Error).message}` }
  }

  it('certifies the login: not an owner, exact grants, current_user is the login', async () => {
    const report = await certifyBooktxRole(probe)
    expect({ ok: report.ok, failures: report.role.failures, probes: report.probes.filter((item) => !item.ok) }).toEqual({ ok: true, failures: [], probes: [] })
    const [who] = await probe.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
    expect(who.current_user).toBe(BOOKTX_LOGIN_ROLE)
  })

  it('allows a zero agency wallet and the booking HOLD, and refuses a house wallet, a credit line and a foreign ledger key', async () => {
    const wallet = await asTenant(tenantA, (tx) => tx.wallet.create({
      data: { tenantId: tenantA, agencyId: agencyA, currency: 'AED', creditLimit: 0n, cachedBalance: 0n },
      select: { id: true },
    }))
    expect(await denied(() => asTenant(tenantA, (tx) => tx.wallet.create({
      data: { tenantId: tenantA, agencyId: agencyA, currency: 'USD', creditLimit: 1n, cachedBalance: 0n },
    })))).toMatch(/42501|credit limit/i)
    expect(await denied(() => asTenant(tenantA, (tx) => tx.wallet.create({
      data: { tenantId: tenantA, currency: 'AED', creditLimit: 0n, cachedBalance: 0n },
    })))).toMatch(/42501|house account/i)

    const bookingId = (await owner.booking.findFirstOrThrow({ where: { tenantId: tenantA } })).id
    await asTenant(tenantA, (tx) => tx.ledgerEntry.create({
      data: {
        tenantId: tenantA, walletId: wallet.id, type: 'HOLD', amountMinor: -100n, currency: 'AED',
        reference: `booking:${bookingId}`, idempotencyKey: `booking:${bookingId}:authorize`,
      },
    }))
    expect(await denied(() => asTenant(tenantA, (tx) => tx.ledgerEntry.create({
      data: {
        tenantId: tenantA, walletId: wallet.id, type: 'CREDIT', amountMinor: 100n, currency: 'AED',
        reference: `booking:${bookingId}`, idempotencyKey: `booking:${bookingId}:credit`,
      },
    })))).toMatch(/42501|cannot append/i)
  })

  it('updates booking status and refuses the price, and forced RLS hides the other tenant', async () => {
    const booking = await owner.booking.findFirstOrThrow({ where: { tenantId: tenantA } })
    await asTenant(tenantA, (tx) => tx.booking.updateMany({ where: { id: booking.id }, data: { status: 'PENDING_SUPPLIER' } }))
    expect(await denied(() => asTenant(tenantA, (tx) => tx.booking.updateMany({ where: { id: booking.id }, data: { totalMinor: 1n } })))).toMatch(/42501|permission denied/i)
    expect(await asTenant(tenantB, (tx) => tx.booking.count())).toBe(0)
    expect(await asTenant(tenantA, (tx) => tx.booking.count())).toBe(1)
  })

  it('opens the Nest client as this login and refuses when the URL is the API credential', async () => {
    const database = new BookingTransactionDatabase({ DATABASE_URL: ownerUrl, BOOKING_TRANSACTION_DATABASE_URL: roleUrl })
    const who = await database.withTenant(tenantA, async (tx) => {
      const [row] = await tx.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
      return row.current_user
    })
    expect(who).toBe(BOOKTX_LOGIN_ROLE)
    await database.onModuleDestroy()

    const reused = new BookingTransactionDatabase({ DATABASE_URL: roleUrl, BOOKING_TRANSACTION_DATABASE_URL: roleUrl })
    await expect(reused.withTenant(tenantA, async () => 'ran')).rejects.toMatchObject({ response: { code: BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE } })
  })
})
