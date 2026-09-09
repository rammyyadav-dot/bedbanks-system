import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * P0-C seed strategy: small, deterministic, idempotent.
 *
 * Uses `upsert` everywhere so running this repeatedly never creates
 * duplicates or throws on a unique constraint — safe to re-run against
 * the same dev database as many times as needed while iterating.
 *
 * Deliberately minimal: one tenant, one user, one membership. This is
 * enough to exercise the schema end-to-end without inventing fixtures
 * for domain models (hotels, bookings, etc.) that don't exist until P1.
 */
async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-agency' },
    update: {},
    create: {
      name: 'Demo Travel Agency',
      slug: 'demo-agency',
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'owner@demo-agency.example' },
    update: {},
    create: {
      email: 'owner@demo-agency.example',
      name: 'Demo Owner',
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_tenantId: {
        userId: user.id,
        tenantId: tenant.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      tenantId: tenant.id,
      role: 'owner',
    },
  });

  console.log('Seed complete:');
  console.log(`  Tenant:     ${tenant.name} (${tenant.slug})`);
  console.log(`  User:       ${user.email}`);
  console.log(`  Membership: owner`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
