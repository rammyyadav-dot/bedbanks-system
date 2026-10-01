/**
 * Explicit, test-only preview fixtures. Refuses every database except the
 * empty disposable name `fbeds_preview_xt`.
 *
 *   PROVISION_DATABASE_URL=<owner credential for fbeds_preview_xt> \
 *   PREVIEW_FIXTURE_SECRET_FILE=/absolute/path/outside/the/repo.json \
 *   pnpm --filter @bedbanks/api ops:provision-preview-fixtures
 *
 * Passwords are generated and written only to that file (mode 600).
 * The process prints identifiers and never prints credentials.
 * Re-running rotates the fixture passwords and refreshes stay dates.
 * It does not enable booking, payments, publication, or live suppliers.
 */
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { isAbsolute, resolve, dirname, sep } from 'path'
import { PrismaClient, type Prisma } from '@prisma/client'
import { hashPassword } from '../auth/utils/password'
import { assertPreviewFixtureTarget, PREVIEW_FIXTURE_DATABASE } from './preview-fixture-target'

const TENANT_A = 'preview-tenant-a'
const TENANT_B = 'preview-tenant-b'
const NIGHT_MINOR = 45000n
const STAY_NIGHTS = 21

const ACCOUNTS = {
  admin: { email: 'preview-admin@example.test', name: 'Preview Admin' },
  restricted: { email: 'preview-restricted@example.test', name: 'Preview Restricted Admin' },
  agent: { email: 'preview-agent@example.test', name: 'Preview Agent' },
  supplierEditor: { email: 'preview-supplier-editor@example.test', name: 'Preview Supplier Editor' },
  supplierReader: { email: 'preview-supplier-reader@example.test', name: 'Preview Supplier Reader' },
  supplierBeta: { email: 'preview-supplier-beta@example.test', name: 'Preview Supplier Beta' },
  supplierRevoked: { email: 'preview-supplier-revoked@example.test', name: 'Preview Supplier Revoked' },
  tenantB: { email: 'preview-tenant-b@example.test', name: 'Preview Tenant B Agent' },
} as const

const ADMIN_PERMISSIONS = [
  'dashboard.read',
  'supply.hotels.read',
  'supply.rooms.read',
  'supply.suppliers.read',
  'supply.rates.read',
  'supply.contracts.read',
  'supply.mappings.read',
  'supply.availability.read',
]
const AGENT_PERMISSIONS = ['hotel.search', 'booking.prebook', 'booking.create']
const EDITOR_PERMISSIONS = ['supplier.extranet.hotels.read', 'supplier.extranet.rooms.read', 'supplier.extranet.drafts.manage']
const READER_PERMISSIONS = ['supplier.extranet.hotels.read', 'supplier.extranet.rooms.read']

type Tx = Prisma.TransactionClient

function utcDate(offset: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
}

function isoDate(offset: number): string {
  return utcDate(offset).toISOString().slice(0, 10)
}

function generatedPassword(): string {
  return randomBytes(24).toString('base64url')
}

function secretFilePath(): string {
  const requested = process.env.PREVIEW_FIXTURE_SECRET_FILE ?? ''
  if (!isAbsolute(requested)) {
    throw new Error('PREVIEW_FIXTURE_SECRET_FILE must be an absolute path outside the repository')
  }
  const resolved = resolve(requested)
  const repositoryRoot = resolve(__dirname, '../../../..')
  if (resolved === repositoryRoot || resolved.startsWith(repositoryRoot + sep)) {
    throw new Error('Refusing to write fixture secrets inside the repository')
  }
  return resolved
}

async function withTenant<T>(prisma: PrismaClient, tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
    return work(tx)
  })
}

async function ensurePermissions(prisma: PrismaClient, keys: string[]): Promise<Map<string, string>> {
  const rows = await Promise.all(keys.map((key) => prisma.permission.upsert({
    where: { key },
    update: {},
    create: { key, description: `Preview fixture ${key}` },
  })))
  return new Map(rows.map((row) => [row.key, row.id]))
}

async function ensureUser(prisma: PrismaClient, email: string, name: string, passwordHash: string) {
  return prisma.user.upsert({
    where: { email },
    update: { name, passwordHash, status: 'ACTIVE' },
    create: { email, name, passwordHash, status: 'ACTIVE' },
  })
}

async function ensureRole(tx: Tx, tenantId: string, name: string, permissionIds: string[]) {
  const role = await tx.role.upsert({
    where: { tenantId_name: { tenantId, name } },
    update: {},
    create: { tenantId, name },
  })
  if (permissionIds.length) {
    await tx.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    })
  }
  return role
}

async function ensureAssignment(tx: Tx, tenantId: string, userId: string, roleId: string, membershipRole: string) {
  await tx.membership.upsert({
    where: { userId_tenantId: { userId, tenantId } },
    update: { role: membershipRole },
    create: { userId, tenantId, role: membershipRole },
  })
  await tx.userRole.upsert({
    where: { userId_roleId: { userId, roleId } },
    update: {},
    create: { userId, roleId, tenantId },
  })
}

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  if (!url) throw new Error('PROVISION_DATABASE_URL is required')
  const target = assertPreviewFixtureTarget(url, process.argv.slice(2))
  const secretsPath = secretFilePath()
  const passwords = Object.fromEntries(Object.values(ACCOUNTS).map((account) => [account.email, generatedPassword()])) as Record<string, string>
  const hashes = new Map<string, string>()
  for (const [email, password] of Object.entries(passwords)) hashes.set(email, await hashPassword(password))

  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    const applied = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
    if (Number(applied[0]?.n ?? 0) < 1) throw new Error('Refusing to seed before committed migrations are applied')

    const unexpected = await prisma.tenant.findMany({
      where: { slug: { notIn: [TENANT_A, TENANT_B] } },
      select: { slug: true },
    })
    if (unexpected.length) {
      throw new Error(`Refusing to seed because ${PREVIEW_FIXTURE_DATABASE} already contains other tenants`)
    }

    const permissionIds = await ensurePermissions(prisma, [...new Set([
      ...ADMIN_PERMISSIONS, ...AGENT_PERMISSIONS, ...EDITOR_PERMISSIONS, ...READER_PERMISSIONS,
    ])])
    const ids = (keys: string[]) => keys.map((key) => {
      const id = permissionIds.get(key)
      if (!id) throw new Error(`Missing permission ${key}`)
      return id
    })

    const users = {
      admin: await ensureUser(prisma, ACCOUNTS.admin.email, ACCOUNTS.admin.name, hashes.get(ACCOUNTS.admin.email)!),
      restricted: await ensureUser(prisma, ACCOUNTS.restricted.email, ACCOUNTS.restricted.name, hashes.get(ACCOUNTS.restricted.email)!),
      agent: await ensureUser(prisma, ACCOUNTS.agent.email, ACCOUNTS.agent.name, hashes.get(ACCOUNTS.agent.email)!),
      supplierEditor: await ensureUser(prisma, ACCOUNTS.supplierEditor.email, ACCOUNTS.supplierEditor.name, hashes.get(ACCOUNTS.supplierEditor.email)!),
      supplierReader: await ensureUser(prisma, ACCOUNTS.supplierReader.email, ACCOUNTS.supplierReader.name, hashes.get(ACCOUNTS.supplierReader.email)!),
      supplierBeta: await ensureUser(prisma, ACCOUNTS.supplierBeta.email, ACCOUNTS.supplierBeta.name, hashes.get(ACCOUNTS.supplierBeta.email)!),
      supplierRevoked: await ensureUser(prisma, ACCOUNTS.supplierRevoked.email, ACCOUNTS.supplierRevoked.name, hashes.get(ACCOUNTS.supplierRevoked.email)!),
      tenantB: await ensureUser(prisma, ACCOUNTS.tenantB.email, ACCOUNTS.tenantB.name, hashes.get(ACCOUNTS.tenantB.email)!),
    }

    const tenantA = await prisma.tenant.upsert({
      where: { slug: TENANT_A },
      update: { name: 'Preview Tenant A', status: 'ACTIVE' },
      create: { name: 'Preview Tenant A', slug: TENANT_A, status: 'ACTIVE' },
    })
    const tenantB = await prisma.tenant.upsert({
      where: { slug: TENANT_B },
      update: { name: 'Preview Tenant B', status: 'ACTIVE' },
      create: { name: 'Preview Tenant B', slug: TENANT_B, status: 'ACTIVE' },
    })

    const alpha = await seedTenantA(prisma, tenantA.id, users, ids)
    const betaHotel = await seedTenantB(prisma, tenantB.id, users.tenantB.id, ids(AGENT_PERMISSIONS))

    mkdirSync(dirname(secretsPath), { recursive: true })
    writeFileSync(secretsPath, JSON.stringify({
      database: target.database,
      purpose: 'disposable preview fixtures',
      expiresOn: '2026-10-08',
      accounts: passwords,
    }, null, 2), { mode: 0o600 })

    console.log(JSON.stringify({
      database: target.database,
      host: target.host,
      tenantA: tenantA.id,
      tenantB: tenantB.id,
      supplierAlpha: alpha.supplierAlpha,
      supplierBeta: alpha.supplierBeta,
      hotelAlpha: alpha.hotelAlpha,
      roomAlpha: alpha.roomAlpha,
      hotelBeta: alpha.hotelBeta,
      roomBeta: alpha.roomBeta,
      hotelTenantB: betaHotel.hotelId,
      checkIn: isoDate(0),
      checkOut: isoDate(3),
      currency: 'AED',
      nightAmountMinor: NIGHT_MINOR.toString(),
      accounts: Object.values(ACCOUNTS).map((account) => account.email),
      secretFile: secretsPath,
    }))
  } finally {
    await prisma.$disconnect()
  }
}

async function seedTenantA(
  prisma: PrismaClient,
  tenantId: string,
  users: Record<keyof typeof ACCOUNTS, { id: string }>,
  ids: (keys: string[]) => string[],
) {
  return withTenant(prisma, tenantId, async (tx) => {
    const adminRole = await ensureRole(tx, tenantId, 'Preview authorized admin', ids(ADMIN_PERMISSIONS))
    const restrictedRole = await ensureRole(tx, tenantId, 'Preview restricted admin', [])
    const agentRole = await ensureRole(tx, tenantId, 'Preview agent', ids(AGENT_PERMISSIONS))
    const editorRole = await ensureRole(tx, tenantId, 'Preview supplier editor', ids(EDITOR_PERMISSIONS))
    const readerRole = await ensureRole(tx, tenantId, 'Preview supplier reader', ids(READER_PERMISSIONS))
    await ensureAssignment(tx, tenantId, users.admin.id, adminRole.id, 'admin')
    await ensureAssignment(tx, tenantId, users.restricted.id, restrictedRole.id, 'staff')
    await ensureAssignment(tx, tenantId, users.agent.id, agentRole.id, 'agent')
    await ensureAssignment(tx, tenantId, users.supplierEditor.id, editorRole.id, 'member')
    await ensureAssignment(tx, tenantId, users.supplierReader.id, readerRole.id, 'member')
    await ensureAssignment(tx, tenantId, users.supplierBeta.id, editorRole.id, 'member')
    await ensureAssignment(tx, tenantId, users.supplierRevoked.id, readerRole.id, 'member')

    const supplierAlpha = await tx.supplier.upsert({
      where: { tenantId_legalName: { tenantId, legalName: 'Preview Supplier Alpha' } },
      update: { status: 'ACTIVE', displayName: 'Preview Supplier Alpha', defaultCurrency: 'AED' },
      create: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: 'Preview Supplier Alpha', displayName: 'Preview Supplier Alpha', countryCode: 'AE', defaultCurrency: 'AED' },
    })
    const supplierBeta = await tx.supplier.upsert({
      where: { tenantId_legalName: { tenantId, legalName: 'Preview Supplier Beta' } },
      update: { status: 'ACTIVE', displayName: 'Preview Supplier Beta', defaultCurrency: 'AED' },
      create: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: 'Preview Supplier Beta', displayName: 'Preview Supplier Beta', countryCode: 'AE', defaultCurrency: 'AED' },
    })
    await tx.supplierMembership.upsert({
      where: { userId_tenantId_supplierId: { userId: users.supplierEditor.id, tenantId, supplierId: supplierAlpha.id } },
      update: { status: 'ACTIVE' },
      create: { userId: users.supplierEditor.id, tenantId, supplierId: supplierAlpha.id, status: 'ACTIVE' },
    })
    await tx.supplierMembership.upsert({
      where: { userId_tenantId_supplierId: { userId: users.supplierReader.id, tenantId, supplierId: supplierAlpha.id } },
      update: { status: 'ACTIVE' },
      create: { userId: users.supplierReader.id, tenantId, supplierId: supplierAlpha.id, status: 'ACTIVE' },
    })
    await tx.supplierMembership.upsert({
      where: { userId_tenantId_supplierId: { userId: users.supplierRevoked.id, tenantId, supplierId: supplierAlpha.id } },
      update: { status: 'REVOKED' },
      create: { userId: users.supplierRevoked.id, tenantId, supplierId: supplierAlpha.id, status: 'REVOKED' },
    })
    await tx.supplierMembership.upsert({
      where: { userId_tenantId_supplierId: { userId: users.supplierBeta.id, tenantId, supplierId: supplierBeta.id } },
      update: { status: 'ACTIVE' },
      create: { userId: users.supplierBeta.id, tenantId, supplierId: supplierBeta.id, status: 'ACTIVE' },
    })

    const alphaHotel = await seedHotel(tx, tenantId, supplierAlpha.id, {
      name: 'Preview Marina Dubai',
      externalRef: 'preview-marina-dubai',
      supplierHotelId: 'PREVIEW-ALPHA-DXB',
      roomCode: 'DLX',
      roomName: 'Deluxe King',
      supplierRoomId: 'PREVIEW-ALPHA-DLX',
      contractCode: 'PREVIEW-ALPHA-C',
      planCode: 'PREVIEW-ALPHA-FLEX',
    })
    const betaHotel = await seedHotel(tx, tenantId, supplierBeta.id, {
      name: 'Preview Creek Dubai',
      externalRef: 'preview-creek-dubai',
      supplierHotelId: 'PREVIEW-BETA-DXB',
      roomCode: 'SUP',
      roomName: 'Superior Twin',
      supplierRoomId: 'PREVIEW-BETA-SUP',
      contractCode: 'PREVIEW-BETA-C',
      planCode: 'PREVIEW-BETA-FLEX',
    })
    return {
      supplierAlpha: supplierAlpha.id,
      supplierBeta: supplierBeta.id,
      hotelAlpha: alphaHotel.hotelId,
      roomAlpha: alphaHotel.roomId,
      hotelBeta: betaHotel.hotelId,
      roomBeta: betaHotel.roomId,
    }
  })
}

async function seedTenantB(prisma: PrismaClient, tenantId: string, userId: string, permissionIds: string[]) {
  return withTenant(prisma, tenantId, async (tx) => {
    const role = await ensureRole(tx, tenantId, 'Preview tenant B agent', permissionIds)
    await ensureAssignment(tx, tenantId, userId, role.id, 'agent')
    const supplier = await tx.supplier.upsert({
      where: { tenantId_legalName: { tenantId, legalName: 'Preview Tenant B Supply' } },
      update: { status: 'ACTIVE', displayName: 'Preview Tenant B Supply' },
      create: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: 'Preview Tenant B Supply', displayName: 'Preview Tenant B Supply', countryCode: 'AE', defaultCurrency: 'AED' },
    })
    return seedHotel(tx, tenantId, supplier.id, {
      name: 'Preview Other Tenant Dubai',
      externalRef: 'preview-other-tenant-dubai',
      supplierHotelId: 'PREVIEW-TENANT-B-DXB',
      roomCode: 'STD',
      roomName: 'Standard Queen',
      supplierRoomId: 'PREVIEW-TENANT-B-STD',
      contractCode: 'PREVIEW-TENANT-B-C',
      planCode: 'PREVIEW-TENANT-B-FLEX',
    })
  })
}

async function seedHotel(tx: Tx, tenantId: string, supplierId: string, input: {
  name: string
  externalRef: string
  supplierHotelId: string
  roomCode: string
  roomName: string
  supplierRoomId: string
  contractCode: string
  planCode: string
}) {
  const hotel = await tx.hotel.upsert({
    where: { tenantId_externalRef: { tenantId, externalRef: input.externalRef } },
    update: { name: input.name, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', propertyType: 'HOTEL', starRating: 5 },
    create: { tenantId, name: input.name, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', address: 'Synthetic preview address', contentStatus: 'COMPLETE', externalRef: input.externalRef, timeZone: 'Asia/Dubai' },
  })
  const room = await tx.roomType.upsert({
    where: { hotelId_code: { hotelId: hotel.id, code: input.roomCode } },
    update: { name: input.roomName, isActive: true, maxAdults: 2, maxOccupancy: 2 },
    create: { hotelId: hotel.id, name: input.roomName, code: input.roomCode, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true },
  })
  const board = await tx.boardBasis.upsert({
    where: { tenantId_code: { tenantId, code: 'BB' } },
    update: { name: 'Bed and Breakfast', isActive: true },
    create: { tenantId, code: 'BB', name: 'Bed and Breakfast', isActive: true },
  })
  const mapping = await tx.supplierHotelMapping.upsert({
    where: { supplierId_hotelId: { supplierId, hotelId: hotel.id } },
    update: { status: 'MAPPED', supplierHotelId: input.supplierHotelId },
    create: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: input.supplierHotelId, status: 'MAPPED' },
  })
  const existingRoomMapping = await tx.supplierRoomMapping.findFirst({
    where: { supplierHotelMappingId: mapping.id, supplierRoomId: input.supplierRoomId },
  })
  const roomMapping = existingRoomMapping
    ? await tx.supplierRoomMapping.update({ where: { id: existingRoomMapping.id }, data: { status: 'MAPPED', roomTypeId: room.id, hotelId: hotel.id } })
    : await tx.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: input.supplierRoomId, roomTypeId: room.id, status: 'MAPPED' } })
  const contract = await tx.contract.upsert({
    where: { tenantId_code_version: { tenantId, code: input.contractCode, version: 1 } },
    update: { status: 'ACTIVE', validFrom: utcDate(-1), validTo: utcDate(90), settlementCurrency: 'AED', supplierId, supplierHotelMappingId: mapping.id },
    create: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: input.contractCode, version: 1, status: 'ACTIVE', validFrom: utcDate(-1), validTo: utcDate(90), settlementCurrency: 'AED' },
  })
  const plan = await tx.ratePlan.upsert({
    where: { contractId_code: { contractId: contract.id, code: input.planCode } },
    update: { status: 'ACTIVE', roomTypeId: room.id, boardBasisId: board.id, occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0 },
    create: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: input.planCode, status: 'ACTIVE', occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0 },
  })
  for (let offset = 0; offset < STAY_NIGHTS; offset += 1) {
    const stayDate = utcDate(offset)
    await tx.dailyRate.upsert({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: plan.id, stayDate, occupancy: 2 } },
      update: { amountMinor: NIGHT_MINOR, amountBasis: 'SELL', currency: 'AED' },
      create: { tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: NIGHT_MINOR, amountBasis: 'SELL', currency: 'AED' },
    })
    await tx.dailyAvailability.upsert({
      where: { ratePlanId_stayDate: { ratePlanId: plan.id, stayDate } },
      update: { allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1 },
      create: { tenantId, ratePlanId: plan.id, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1 },
    })
  }
  return { hotelId: hotel.id, roomId: room.id, mappingId: mapping.id, roomMappingId: roomMapping.id, ratePlanId: plan.id }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Preview fixture provisioning failed')
    process.exit(1)
  })
}
