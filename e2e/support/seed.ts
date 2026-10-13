import { PrismaClient, bcrypt } from './db'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * Disposable fixtures for the browser journeys. Everything is created through the owner connection into a fresh tenant with a unique suffix and
 * removed again by `teardown`. Nothing here is a product code path: it only arranges what a real operator would already have (a hotel, a mapped
 * supplier contract, two people who may manage rates), so the journeys can start where a person would.
 */
export const PASSWORD = 'journey-password-123'
const STATE = path.join(__dirname, '..', '.state', 'seed.json')
const DAY = 86_400_000
export const day = (offset: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offset * DAY).toISOString().slice(0, 10)

export interface SeedState {
  suffix: string; tenantId: string; otherTenantId: string
  operator: string; approver: string; readonly: string; outsider: string; agent: string
  hotelId: string; hotelName: string; roomId: string; roomName: string; boardId: string; contractId: string; contractCode: string; supplierId: string
  parentPlanId: string; parentPlanCode: string
  userIds: string[]
}

export const readState = (): SeedState => JSON.parse(readFileSync(STATE, 'utf8')) as SeedState

export async function seed(prisma: PrismaClient): Promise<SeedState> {
  const suffix = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const tenant = await prisma.tenant.create({ data: { name: `Journeys ${suffix}`, slug: suffix } })
  const other = await prisma.tenant.create({ data: { name: `Journeys ${suffix} other`, slug: `${suffix}-other` } })
  const hash = await bcrypt.hash(PASSWORD, 10)
  const userIds: string[] = []
  const RATES = ['hotels', 'rooms', 'rates', 'contracts', 'availability', 'suppliers', 'mappings'].flatMap((area) => [`supply.${area}.read`, `supply.${area}.manage`])
  const mkUser = async (tenantId: string, label: string, keys: string[]) => {
    const email = `${suffix}-${label}@example.test`
    const user = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    userIds.push(user.id)
    await prisma.membership.create({ data: { tenantId, userId: user.id, role: 'owner' } })
    const role = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
    await prisma.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } })
    return email
  }
  const operator = await mkUser(tenant.id, 'operator', RATES)
  const approver = await mkUser(tenant.id, 'approver', RATES)
  const readonly = await mkUser(tenant.id, 'readonly', RATES.filter((key) => key.endsWith('.read')))
  const outsider = await mkUser(other.id, 'outsider', RATES)
  const agent = await mkUser(tenant.id, 'agent', ['hotel.search'])

  const supplier = await prisma.supplier.create({ data: { tenantId: tenant.id, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'Journey Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })
  const board = await prisma.boardBasis.create({ data: { tenantId: tenant.id, code: 'BB', name: 'Bed & Breakfast' } })
  const hotelName = `Journey Hotel ${suffix}`
  const hotel = await prisma.hotel.create({ data: { tenantId: tenant.id, name: hotelName, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 5 } })
  const roomName = 'Deluxe King'
  const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: roomName, code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3 } })
  const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId: tenant.id, supplierId: supplier.id, hotelId: hotel.id, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })
  await prisma.supplierRoomMapping.create({ data: { tenantId: tenant.id, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-r`, roomTypeId: room.id, status: 'MAPPED' } })
  const contractCode = `JC-${suffix}`
  const contract = await prisma.contract.create({ data: { tenantId: tenant.id, supplierId: supplier.id, supplierHotelMappingId: mapping.id, code: contractCode, status: 'ACTIVE', validFrom: new Date(day(-30)), validTo: new Date(day(365)), settlementCurrency: 'AED' } })
  await prisma.cancellationPolicy.create({ data: { contractId: contract.id, daysBeforeCheckin: 7, penaltyPercent: 100 } })
  await prisma.commercialMarkupRule.create({ data: { tenantId: tenant.id, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date(day(-30)), status: 'ACTIVE', activatedAt: new Date(), reason: 'Journey margin', createdById: userIds[0]! } })
  // An active parent plan with 75 nights of rates, for the derived-price journey.
  const parentPlanCode = `PARENT-${suffix}`
  const parent = await prisma.ratePlan.create({ data: { tenantId: tenant.id, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: parentPlanCode, status: 'ACTIVE', refundable: true, occupancy: 2, currency: 'AED' } })
  const nights = Array.from({ length: 75 }, (_, i) => new Date(day(-5 + i)))
  await prisma.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenant.id, ratePlanId: parent.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'NET' as const })) })
  await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenant.id, ratePlanId: parent.id, stayDate, allotment: 5 })) })

  const agency = await prisma.agency.create({ data: { tenantId: tenant.id, code: `AG-${suffix.slice(-6).toUpperCase()}`, name: 'Journey Travel', createdById: userIds[0]! } })
  await prisma.agencyMember.create({ data: { tenantId: tenant.id, agencyId: agency.id, userId: userIds[userIds.length - 1]! } })

  const state: SeedState = { suffix, tenantId: tenant.id, otherTenantId: other.id, operator, approver, readonly, outsider, agent, hotelId: hotel.id, hotelName, roomId: room.id, roomName, boardId: board.id, contractId: contract.id, contractCode, supplierId: supplier.id, parentPlanId: parent.id, parentPlanCode, userIds }
  mkdirSync(path.dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(state))
  return state
}

export async function teardown(prisma: PrismaClient): Promise<void> {
  if (!existsSync(STATE)) return
  const state = readState()
  const tenants = { in: [state.tenantId, state.otherTenantId] }
  await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
  await prisma.approvalRequest.deleteMany({ where: { tenantId: tenants } })
  await prisma.agencyMember.deleteMany({ where: { tenantId: tenants } })
  await prisma.agency.deleteMany({ where: { tenantId: tenants } })
  await prisma.ratePlanPromotion.deleteMany({ where: { tenantId: tenants } })
  await prisma.ratePlanGuestPrice.deleteMany({ where: { tenantId: tenants } })
  await prisma.dailyRate.deleteMany({ where: { tenantId: tenants } })
  await prisma.dailyAvailability.deleteMany({ where: { tenantId: tenants } })
  await prisma.ratePlan.updateMany({ where: { tenantId: tenants }, data: { derivedFromId: null, derivedMode: null, derivedAdjustment: null } })
  await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
  await prisma.commercialMarkupRule.deleteMany({ where: { tenantId: tenants } })
  await prisma.cancellationPolicy.deleteMany({ where: { contract: { tenantId: tenants } } })
  await prisma.contract.deleteMany({ where: { tenantId: tenants } })
  await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: tenants } })
  await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: tenants } })
  await prisma.roomType.deleteMany({ where: { hotel: { tenantId: tenants } } })
  await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
  await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } })
  await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
  await prisma.userRole.deleteMany({ where: { userId: { in: state.userIds } } })
  await prisma.role.deleteMany({ where: { tenantId: tenants } })
  await prisma.membership.deleteMany({ where: { userId: { in: state.userIds } } })
  await prisma.session.deleteMany({ where: { userId: { in: state.userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: state.userIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenants } })
  rmSync(STATE)
}
