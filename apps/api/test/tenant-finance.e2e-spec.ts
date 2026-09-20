import { PrismaClient, type Prisma } from '@prisma/client'
import { sanitizeAuditPayload } from '../src/agent/audit-payload'

describe('tenant and finance PostgreSQL hardening', () => {
  const prisma = new PrismaClient()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const tenantA = `tenant-a-${suffix}`
  const tenantB = `tenant-b-${suffix}`
  const userA = `user-a-${suffix}@example.test`
  const userB = `user-b-${suffix}@example.test`

  beforeAll(async () => {
    await prisma.$connect()
    await prisma.$executeRawUnsafe('DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \'fbeds_rls_test\') THEN CREATE ROLE fbeds_rls_test NOLOGIN; END IF; END $$;')
    await prisma.$executeRawUnsafe('GRANT fbeds_rls_test TO CURRENT_USER')
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fbeds_rls_test')
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memberships", "Role", "UserRole", "Booking", "Cancellation", "Wallet", "LedgerEntry", "AuditEvent", "Supplier", "Hotel", "RoomType", "BoardBasis", "SupplierHotelMapping", "Contract", "RatePlan", "CancellationPolicy", "ChildPolicy", "BookingLeadTimeRule", "DailyAvailability", "DailyRate", "ConnectorDefinition", "ConnectorCredentialReference", "ConnectorExecution", "InventoryUpdateEvent" TO fbeds_rls_test')
  })

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [tenantA, tenantB] } } })
    await prisma.user.deleteMany({ where: { email: { in: [userA, userB] } } })
    await prisma.$disconnect()
  })

  async function createTenant(slug: string, email: string) {
    const tenant = await prisma.tenant.create({ data: { name: slug, slug } })
    const user = await prisma.user.create({ data: { email } })
    await prisma.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } })
    return { tenant, user }
  }

  async function asTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      return work(tx)
    })
  }

  it('enforces RLS and blocks Tenant A from reading or writing Tenant B wallet data', async () => {
    const a = await createTenant(tenantA, userA)
    const b = await createTenant(tenantB, userB)
    await prisma.wallet.createMany({ data: [{ tenantId: a.tenant.id, currency: 'USD' }, { tenantId: b.tenant.id, currency: 'USD' }] })

    const visibleWallets = await asTenant(a.tenant.id, (tx) => tx.wallet.findMany())
    expect(visibleWallets).toHaveLength(1)
    expect(visibleWallets[0].tenantId).toBe(a.tenant.id)

    await expect(asTenant(a.tenant.id, (tx) => tx.wallet.create({ data: { tenantId: b.tenant.id, currency: 'AED' } }))).rejects.toThrow()
  })

  it('rejects cross-tenant role assignments at the database boundary', async () => {
    const a = await createTenant(`${tenantA}-role`, `${userA}.role`)
    const b = await createTenant(`${tenantB}-role`, `${userB}.role`)
    const role = await prisma.role.create({ data: { tenantId: a.tenant.id, name: 'booking-manager' } })

    await expect(prisma.userRole.create({ data: { userId: b.user.id, roleId: role.id, tenantId: a.tenant.id } })).rejects.toThrow('matching membership')
  })

  it('scopes booking idempotency to the tenant', async () => {
    const a = await createTenant(`${tenantA}-booking`, `${userA}.booking`)
    const b = await createTenant(`${tenantB}-booking`, `${userB}.booking`)
    const key = `booking-key-${suffix}`
    const data = { supplier: 'test-supplier', hotelId: 'hotel-1', status: 'PENDING' as const, currency: 'USD', totalMinor: 12500n, idempotencyKey: key, searchSnapshot: {} }

    await prisma.booking.create({ data: { ...data, tenantId: a.tenant.id, reference: `A-${suffix}` } })
    await expect(prisma.booking.create({ data: { ...data, tenantId: a.tenant.id, reference: `A-duplicate-${suffix}` } })).rejects.toThrow()
    await expect(prisma.booking.create({ data: { ...data, tenantId: b.tenant.id, reference: `B-${suffix}` } })).resolves.toMatchObject({ tenantId: b.tenant.id })
  })

  it('supports multiple wallet currencies and records redacted audit payloads', async () => {
    const a = await createTenant(`${tenantA}-finance`, `${userA}.finance`)
    const [usd, aed] = await Promise.all([
      prisma.wallet.create({ data: { tenantId: a.tenant.id, currency: 'USD' } }),
      prisma.wallet.create({ data: { tenantId: a.tenant.id, currency: 'AED' } }),
    ])
    expect(usd.currency).toBe('USD')
    expect(aed.currency).toBe('AED')

    const payload = sanitizeAuditPayload({ destination: 'Dubai', password: 'never-store', nested: { token: 'never-store' } })
    const audit = await prisma.auditEvent.create({ data: { tenantId: a.tenant.id, actorType: 'SYSTEM', action: 'test.audit', entityType: 'test', entityId: suffix, payload } })
    expect(audit.payload).toMatchObject({ password: '[REDACTED]', nested: { token: '[REDACTED]' } })
  })

  it('requires tenant context and makes ledger and audit records immutable to an ordinary application role', async () => {
    const a = await createTenant(`${tenantA}-immutable`, `${userA}.immutable`)
    const wallet = await prisma.wallet.create({ data: { tenantId: a.tenant.id, currency: 'USD' } })
    const ledger = await prisma.ledgerEntry.create({
      data: { tenantId: a.tenant.id, walletId: wallet.id, currency: 'USD', amountMinor: 100n, type: 'CREDIT', idempotencyKey: `ledger-${suffix}` },
    })
    const audit = await prisma.auditEvent.create({
      data: { tenantId: a.tenant.id, actorType: 'USER', action: 'test.immutable', entityType: 'test', entityId: suffix, payload: {} },
    })

    const withoutContext = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
      return tx.wallet.findMany({ where: { tenantId: a.tenant.id } })
    })
    expect(withoutContext).toHaveLength(0)

    await expect(asTenant(a.tenant.id, (tx) => tx.ledgerEntry.update({ where: { id: ledger.id }, data: { amountMinor: 200n } }))).rejects.toThrow()
    await expect(asTenant(a.tenant.id, (tx) => tx.ledgerEntry.delete({ where: { id: ledger.id } }))).rejects.toThrow()
    await expect(asTenant(a.tenant.id, (tx) => tx.auditEvent.update({ where: { id: audit.id }, data: { action: 'tampered' } }))).rejects.toThrow()
    await expect(asTenant(a.tenant.id, (tx) => tx.auditEvent.delete({ where: { id: audit.id } }))).rejects.toThrow()
    await expect(asTenant(a.tenant.id, (tx) => tx.auditEvent.create({
      data: { tenantId: a.tenant.id, actorType: 'SYSTEM', action: 'test.system', entityType: 'test', entityId: suffix, payload: {} },
    }))).rejects.toThrow()
  })

  it('keeps supply, rate and connector records tenant-isolated and validates inventory constraints', async () => {
    const a = await createTenant(`${tenantA}-supply`, `${userA}.supply`)
    const b = await createTenant(`${tenantB}-supply`, `${userB}.supply`)
    const supplier = await prisma.supplier.create({ data: { tenantId: a.tenant.id, type: 'DMC', legalName: `Supplier ${suffix}`, displayName: 'Supply', countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await prisma.hotel.create({ data: { tenantId: a.tenant.id, name: 'Dubai Test Hotel', propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', externalRef: `hotel-${suffix}` } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: 'DLX', maxAdults: 2, maxOccupancy: 2 } })
    const board = await prisma.boardBasis.create({ data: { tenantId: a.tenant.id, code: 'BB', name: 'Bed and Breakfast' } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId: a.tenant.id, supplierId: supplier.id, hotelId: hotel.id, supplierHotelId: `supplier-hotel-${suffix}`, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId: a.tenant.id, supplierId: supplier.id, supplierHotelMappingId: mapping.id, code: `UAE-${suffix}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), settlementCurrency: 'AED' } })
    const ratePlan = await prisma.ratePlan.create({ data: { tenantId: a.tenant.id, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: 'BAR', status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
    await prisma.dailyAvailability.create({ data: { tenantId: a.tenant.id, ratePlanId: ratePlan.id, stayDate: new Date('2026-12-10'), allotment: 3, sold: 1 } })
    await prisma.dailyRate.create({ data: { tenantId: a.tenant.id, ratePlanId: ratePlan.id, stayDate: new Date('2026-12-10'), occupancy: 2, amountMinor: 125000n, currency: 'AED' } })
    const connector = await prisma.connectorDefinition.create({ data: { tenantId: a.tenant.id, supplierId: supplier.id, type: 'MANUAL_EXTRANET', name: 'manual', version: '1' } })

    await expect(prisma.connectorCredentialReference.create({ data: { connectorId: connector.id, purpose: 'primary', secretRef: 'password=unsafe' } })).rejects.toThrow()
    await expect(prisma.dailyAvailability.create({ data: { tenantId: a.tenant.id, ratePlanId: ratePlan.id, stayDate: new Date('2026-12-11'), allotment: 1, sold: 2 } })).rejects.toThrow()
    await expect(prisma.dailyRate.create({ data: { tenantId: a.tenant.id, ratePlanId: ratePlan.id, stayDate: new Date('2026-12-10'), occupancy: 2, amountMinor: 100n, currency: 'AED' } })).rejects.toThrow()

    const visible = await asTenant(a.tenant.id, (tx) => tx.supplier.findMany())
    expect(visible).toHaveLength(1)
    await expect(asTenant(a.tenant.id, (tx) => tx.supplier.create({ data: { tenantId: b.tenant.id, type: 'DMC', legalName: 'Blocked', displayName: 'Blocked', countryCode: 'AE', defaultCurrency: 'AED' } }))).rejects.toThrow()
    await expect(asTenant(b.tenant.id, (tx) => tx.supplier.findMany())).resolves.toHaveLength(0)
  })
})
