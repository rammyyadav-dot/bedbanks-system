import { randomBytes } from 'crypto'
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { hashPassword } from '../src/auth/utils/password'
import { LedgerService } from '../src/agent/ledger.service'
import { PrismaService } from '../src/database/prisma.service'
import { OperationsHotelsService } from '../src/admin-operations/operations-hotels.service'
import { HotelImagesService } from '../src/hotel-setup/hotel-images.service'
import { MappingService } from '../src/supply/mapping.service'
import { SupplyService } from '../src/supply/supply.service'

jest.setTimeout(120_000)

/**
 * ADR 0071: the second wall. PostgreSQL forced RLS is the boundary, but a lost tenant context or a connection that bypasses RLS
 * (platform, tenant-control, compliance, owner tooling) must not widen a query. This suite runs the real services on the schema-owner
 * connection, where RLS does not apply, as a tenant-A member against tenant-B ids. Every denial is paired with a positive control on
 * tenant A's own data, so a refusal can only come from the explicit tenant predicates and not from a missing row or a missing permission.
 */
describe('tenant second wall: services refuse another tenant with RLS out of the picture (PostgreSQL)', () => {
  const prisma = new PrismaClient()
  const suffix = `sw-${Date.now()}-${randomBytes(3).toString('hex')}`
  const keys = ['supply.hotels.read', 'supply.hotels.manage', 'supply.mappings.read', 'supply.mappings.manage', 'supply.rooms.read', 'supply.rooms.manage']
  let supply: SupplyService, mappings: MappingService, images: HotelImagesService, hotelsOps: OperationsHotelsService, ledger: LedgerService, service: PrismaService
  let closeApp: () => Promise<void>
  let userId = ''
  const A = { tenant: '', supplier: '', hotel: '', mapping: '', image: '', wallet: '' }
  const B = { tenant: '', supplier: '', hotel: '', mapping: '', image: '', wallet: '' }

  async function seed(label: 'A' | 'B') {
    const t = label === 'A' ? A : B
    t.tenant = (await prisma.tenant.create({ data: { name: `${suffix} ${label}`, slug: `${suffix}-${label.toLowerCase()}` } })).id
    t.supplier = (await prisma.supplier.create({ data: { tenantId: t.tenant, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${label}`, displayName: label, countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    t.hotel = (await prisma.hotel.create({ data: { tenantId: t.tenant, name: `${suffix} hotel ${label}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT' } })).id
    t.mapping = (await prisma.supplierHotelMapping.create({ data: { tenantId: t.tenant, supplierId: t.supplier, hotelId: t.hotel, supplierHotelId: `${suffix}-${label}`, status: 'MAPPED' } })).id
    t.image = (await prisma.hotelImage.create({ data: { tenantId: t.tenant, hotelId: t.hotel, contentType: 'image/png', bytes: 4, width: 800, height: 600, sha256: randomBytes(32).toString('hex'), altText: `original ${label}`, isPrimary: true, data: Buffer.from('fake'), uploadedById: userId } })).id
    t.wallet = (await prisma.wallet.create({ data: { tenantId: t.tenant, currency: 'AED' } })).id
  }

  beforeAll(async () => {
    await prisma.$connect()
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test`, name: 'member', passwordHash: await hashPassword('second-wall-password'), status: 'ACTIVE' } })).id
    await seed('A'); await seed('B')
    // The caller is a full supply member of tenant A only.
    await prisma.membership.create({ data: { tenantId: A.tenant, userId, role: 'agent' } })
    const role = await prisma.role.create({ data: { tenantId: A.tenant, name: `${suffix}-role` } })
    for (const key of keys) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
    await prisma.userRole.create({ data: { tenantId: A.tenant, userId, roleId: role.id } })
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = module.createNestApplication(); await app.init()
    closeApp = () => app.close()
    const get = <T>(token: new (...args: never[]) => T) => app.get(token, { strict: false })
    supply = get(SupplyService); mappings = get(MappingService); images = get(HotelImagesService); hotelsOps = get(OperationsHotelsService); ledger = get(LedgerService); service = get(PrismaService)
  })

  afterAll(async () => {
    await closeApp?.()
    for (const tenantId of [A.tenant, B.tenant].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      // The ledger is append-only; a disposable fixture is removed with triggers off, in one transaction, as the other finance suites do.
      await prisma.$transaction([prisma.$executeRawUnsafe('SET LOCAL session_replication_role = replica'), prisma.$executeRaw`DELETE FROM "LedgerChainLink" WHERE tenant_id = ${tenantId}`, prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE tenant_id = ${tenantId}`]) // the hash chain (ADR 0094) references the entries and the wallet
      await prisma.wallet.deleteMany({ where: { tenantId } })
      await prisma.hotelImage.deleteMany({ where: { tenantId } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
      await prisma.tenant.deleteMany({ where: { id: tenantId } })
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  const hotelB = () => prisma.hotel.findUniqueOrThrow({ where: { id: B.hotel } })
  const imageB = () => prisma.hotelImage.findUniqueOrThrow({ where: { id: B.image }, select: { altText: true, isPrimary: true } })

  it('control: this connection really bypasses RLS, so only the services stand between tenant A and tenant B', async () => {
    const [role] = await prisma.$queryRaw<Array<{ bypass: boolean }>>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(role.bypass).toBe(true)
    // With tenant A's context set, a raw read still sees tenant B: nothing below is protected by RLS.
    const seen = await service.withTenant(A.tenant, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Hotel" WHERE "id" IN (${A.hotel}, ${B.hotel})`)
    expect(seen.map((r) => r.id).sort()).toEqual([A.hotel, B.hotel].sort())
  })

  it('lists contain only the caller tenant', async () => {
    expect(JSON.stringify(await supply.hotels(A.tenant, userId))).toContain(A.hotel)
    expect(JSON.stringify(await supply.hotels(A.tenant, userId))).not.toContain(B.hotel)
    const mapped = JSON.stringify(await mappings.hotels(A.tenant, userId))
    expect(mapped).toContain(A.mapping); expect(mapped).not.toContain(B.mapping)
    const commercial = JSON.stringify(await hotelsOps.list(A.tenant, { pageSize: '100' }))
    expect(commercial).toContain(A.hotel); expect(commercial).not.toContain(B.hotel)
  })

  it('reads and updates by another tenant\'s id find nothing and change nothing', async () => {
    // Positive control: the same calls on tenant A's own rows work.
    expect(await mappings.hotel(A.tenant, userId, A.mapping)).toMatchObject({ id: A.mapping })
    await supply.updateHotel(A.tenant, userId, A.hotel, { name: `${suffix} renamed A` })
    expect((await prisma.hotel.findUniqueOrThrow({ where: { id: A.hotel } })).name).toBe(`${suffix} renamed A`)

    const before = await hotelB()
    await expect(mappings.hotel(A.tenant, userId, B.mapping)).rejects.toBeInstanceOf(NotFoundException)
    await expect(supply.updateHotel(A.tenant, userId, B.hotel, { name: 'hijacked' })).rejects.toBeInstanceOf(NotFoundException)
    expect(await hotelB()).toEqual(before)
  })

  it('an image id from another tenant cannot be edited or deleted, whether it is addressed under tenant A\'s hotel or tenant B\'s', async () => {
    // Positive control on tenant A's own image.
    await images.update(A.tenant, userId, A.hotel, A.image, { altText: 'edited A' }, null)
    expect((await prisma.hotelImage.findUniqueOrThrow({ where: { id: A.image } })).altText).toBe('edited A')

    const before = await imageB()
    for (const hotel of [A.hotel, B.hotel]) {
      await expect(images.update(A.tenant, userId, hotel, B.image, { altText: 'hijacked' }, null)).rejects.toBeInstanceOf(NotFoundException)
      await expect(images.remove(A.tenant, userId, hotel, B.image, null)).rejects.toBeInstanceOf(NotFoundException)
    }
    expect(await imageB()).toEqual(before)
  })

  it('a ledger post cannot reach another tenant\'s wallet, and writes nothing into it', async () => {
    const post = (tenantId: string, walletId: string) => ledger.post({ tenantId, walletId, currency: 'AED', amountMinor: 1_000n, type: 'CREDIT', idempotencyKey: `${suffix}-${walletId}`, reference: 'second-wall' })
    // Positive control: tenant A funds its own wallet.
    await post(A.tenant, A.wallet)
    expect(await prisma.ledgerEntry.count({ where: { walletId: A.wallet } })).toBe(1)

    await expect(post(A.tenant, B.wallet)).rejects.toBeInstanceOf(ForbiddenException)
    expect(await prisma.ledgerEntry.count({ where: { walletId: B.wallet } })).toBe(0)
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: B.wallet } })).cachedBalance).toBe(0n)
  })

  it('a replay of the same idempotency key cannot return another tenant\'s entry', async () => {
    const key = `${suffix}-shared-key`
    const credit = (tenantId: string, walletId: string) => ledger.post({ tenantId, walletId, currency: 'AED', amountMinor: 500n, type: 'CREDIT', idempotencyKey: key, reference: 'replay' })
    const own = await credit(B.tenant, B.wallet)
    // The same key against tenant A's wallet is a different entry in a different tenant, never tenant B's.
    const mine = await credit(A.tenant, A.wallet)
    expect(mine.id).not.toBe(own.id)
    expect(mine.tenantId).toBe(A.tenant)
    // And a conflicting amount under the same key in the same tenant is still refused.
    await expect(ledger.post({ tenantId: A.tenant, walletId: A.wallet, currency: 'AED', amountMinor: 999n, type: 'CREDIT', idempotencyKey: key, reference: 'replay' })).rejects.toBeInstanceOf(ConflictException)
  })
})
