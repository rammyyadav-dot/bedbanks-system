import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default roles and permissions
  const adminRole = await prisma.role.upsert({
    where: { key: 'admin' },
    update: {},
    create: {
      key: 'admin',
      name: 'Administrator',
      description: 'Full system access',
    },
  });

  const userRole = await prisma.role.upsert({
    where: { key: 'user' },
    update: {},
    create: {
      key: 'user',
      name: 'User',
      description: 'Standard user access',
    },
  });

  const bookingRole = await prisma.role.upsert({
    where: { key: 'booking_manager' },
    update: {},
    create: {
      key: 'booking_manager',
      name: 'Booking Manager',
      description: 'Manage bookings and inventory',
    },
  });

  // Create permissions
  const permissions = [
    { key: 'manage_tenants', name: 'Manage Tenants' },
    { key: 'manage_users', name: 'Manage Users' },
    { key: 'manage_bookings', name: 'Manage Bookings' },
    { key: 'manage_wallets', name: 'Manage Wallets' },
    { key: 'view_reports', name: 'View Reports' },
    { key: 'manage_api_clients', name: 'Manage API Clients' },
  ];

  const permissionRecords = await Promise.all(
    permissions.map((perm) =>
      prisma.permission.upsert({
        where: { key: perm.key },
        update: {},
        create: perm,
      }),
    ),
  );

  // Assign all permissions to admin role
  for (const permission of permissionRecords) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: {
        roleId: adminRole.id,
        permissionId: permission.id,
      },
    });
  }

  console.log('✅ Seed data created successfully');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
