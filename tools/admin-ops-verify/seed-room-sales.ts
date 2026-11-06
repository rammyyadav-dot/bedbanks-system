// Demo rooms for Room Availability: Classic, Deluxe, Executive and Family Suite, one shared pool.
// DISPOSABLE local database only.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

const ROOMS = [
  ['Classic Room', 'CLS', 2],
  ['Deluxe Room', 'DLX', 3],
  ['Executive Room', 'EXC', 3],
  ['Family Suite', 'FAM', 4],
] as const

async function main() {
  const prisma = new PrismaService()
  const tag = `rs-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (offset: number) => new Date(midnight + offset * 86_400_000)
  const tenantId = (await prisma.tenant.create({ data: { name: `${tag}`, slug: tag } })).id
  const user = await prisma.user.create({ data: { email: `owner-${tag}@verify.test`, name: 'Inventory owner', passwordHash: hash, status: 'ACTIVE' } })
  await prisma.membership.create({ data: { userId: user.id, tenantId, role: 'owner' } })
  const role = await prisma.role.create({ data: { tenantId, name: `owner-${tag}` } })
  for (const key of ['supply.hotels.read', 'supply.hotels.manage', 'supply.availability.read', 'supply.availability.manage', 'supply.rates.read', 'supply.contracts.read']) {
    const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, tenantId } })
  const supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} supplier`, displayName: 'Courtyard contracting', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
  const boardBasisId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
  const hotel = await prisma.hotel.create({ data: { tenantId, name: 'Arabian Courtyard Hotel & Spa', externalRef: `ACY-${tag.slice(-4)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: 'Al Fahidi Street', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 4 } })
  const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${tag}-h`, status: 'MAPPED' } })
  const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${tag}-C`, status: 'ACTIVE', validFrom: utc(-30), validTo: utc(400), settlementCurrency: 'AED', allotmentType: 'GUARANTEED' } as never })
  const pool = await prisma.inventoryPool.create({ data: { tenantId, hotelId: hotel.id, supplierId, name: 'B2B shared pool', createdById: user.id } })
  const range = Array.from({ length: 28 }, (_, index) => utc(index))
  await prisma.inventoryPoolDay.createMany({ data: range.map((stayDate) => ({ tenantId, poolId: pool.id, stayDate, capacity: 10 })) })
  await prisma.poolNightAllocation.createMany({ data: range.map((stayDate) => ({ tenantId, hotelId: hotel.id, poolId: pool.id, stayDate, contracted: 10, approvedAdjustment: 0, blockedQuantity: 0, postReleasePolicy: 'CLOSED' })) })
  for (const [name, code, occupancy] of ROOMS) {
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name, code, maxAdults: occupancy, maxChildren: 1, maxOccupancy: occupancy + 1 } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${tag}-${code}`, roomTypeId: room.id, status: 'MAPPED' } })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code, status: 'ACTIVE', occupancy, currency: 'AED', minStay: 1, inventoryPoolId: pool.id } })
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy, amountMinor: 40_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: 10, inventoryMode: 'ALLOTMENT' as const })) })
  }
  console.log(JSON.stringify({ hotelId: hotel.id, tenantId, email: user.email, password, pool: pool.name, rooms: ROOMS.map((room) => room[0]) }))
  await prisma.$disconnect()
}

main().catch((error) => { console.error(error); process.exit(1) })
