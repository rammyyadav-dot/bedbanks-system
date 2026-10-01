import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/auth/utils/password'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (!/\/fbeds_supplier_xt(\?|$)/.test(databaseUrl)) {
  throw new Error('Refusing to seed because DATABASE_URL is not the disposable fbeds_supplier_xt database')
}

const prisma = new PrismaClient()
const email = 'extranet-browser@example.test'
const password = 'extranet-browser-password'

async function main() {
  const passwordHash = await hashPassword(password)
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'supplier-extranet-browser' },
    update: { name: 'Supplier extranet browser', status: 'ACTIVE' },
    create: { name: 'Supplier extranet browser', slug: 'supplier-extranet-browser' },
  })
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_legalName: { tenantId: tenant.id, legalName: 'Harbor House Hotels' } },
    update: { status: 'ACTIVE', displayName: 'Harbor House Hotels' },
    create: { tenantId: tenant.id, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: 'Harbor House Hotels', displayName: 'Harbor House Hotels', countryCode: 'AE', defaultCurrency: 'AED' },
  })
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, status: 'ACTIVE', name: 'Harbor Operator' },
    create: { email, passwordHash, name: 'Harbor Operator' },
  })
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    update: {},
    create: { userId: user.id, tenantId: tenant.id, role: 'member' },
  })
  const keys = ['supplier.extranet.hotels.read', 'supplier.extranet.rooms.read', 'supplier.extranet.drafts.manage']
  const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Supplier extranet browser' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Supplier extranet browser' },
  })
  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { tenantId: tenant.id, userId: user.id, roleId: role.id },
  })
  await prisma.supplierMembership.upsert({
    where: { userId_tenantId_supplierId: { userId: user.id, tenantId: tenant.id, supplierId: supplier.id } },
    update: { status: 'ACTIVE' },
    create: { userId: user.id, tenantId: tenant.id, supplierId: supplier.id, status: 'ACTIVE' },
  })
  const hotel = await prisma.hotel.upsert({
    where: { tenantId_externalRef: { tenantId: tenant.id, externalRef: 'harbor-house-dubai' } },
    update: { name: 'Harbor House Dubai' },
    create: { tenantId: tenant.id, name: 'Harbor House Dubai', propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', externalRef: 'harbor-house-dubai' },
  })
  const room = await prisma.roomType.upsert({
    where: { hotelId_code: { hotelId: hotel.id, code: 'DLX-KING' } },
    update: { name: 'Deluxe King' },
    create: { hotelId: hotel.id, name: 'Deluxe King', code: 'DLX-KING', maxAdults: 2, maxOccupancy: 3 },
  })
  await prisma.supplierHotelMapping.upsert({
    where: { supplierId_hotelId: { supplierId: supplier.id, hotelId: hotel.id } },
    update: { status: 'MAPPED' },
    create: { tenantId: tenant.id, supplierId: supplier.id, hotelId: hotel.id, supplierHotelId: 'HH-DXB', status: 'MAPPED' },
  })
  console.log(JSON.stringify({ email, hotelId: hotel.id, roomId: room.id, supplierId: supplier.id }))
}

main().finally(() => prisma.$disconnect())
