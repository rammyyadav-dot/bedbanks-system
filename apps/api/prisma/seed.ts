import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const BCRYPT_SALT_ROUNDS = 12;

/**
 * P0-C/D seed strategy: small, deterministic, idempotent.
 *
 * Uses `upsert` everywhere so running this repeatedly never creates
 * duplicates or throws on a unique constraint — safe to re-run against
 * the same dev database as many times as needed while iterating.
 *
 * P0-D addition: the demo user now gets a real, hashed password, so
 * there's an account that can actually log in through
 * POST /api/v1/auth/login during local development — sourced from env
 * vars, never hard-coded, never printed.
 */
async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-agency' },
    update: {},
    create: {
      name: 'Demo Travel Agency',
      slug: 'demo-agency',
      status: 'ACTIVE',
    },
  });

  const seedEmail = (process.env.FBEDS_SEED_ADMIN_EMAIL ?? 'owner@demo-agency.example').trim().toLowerCase();
  const seedPassword = process.env.FBEDS_SEED_ADMIN_PASSWORD;

  if (!seedPassword) {
    throw new Error(
      'FBEDS_SEED_ADMIN_PASSWORD is not set. Set it in apps/api/.env before seeding ' +
        '(e.g. FBEDS_SEED_ADMIN_PASSWORD=a-strong-local-dev-password) — never hard-code it here.',
    );
  }

  const passwordHash = await bcrypt.hash(seedPassword, BCRYPT_SALT_ROUNDS);

  const user = await prisma.user.upsert({
    where: { email: seedEmail },
    update: { passwordHash, status: 'ACTIVE' },
    create: {
      email: seedEmail,
      name: 'Demo Owner',
      passwordHash,
      status: 'ACTIVE',
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
  console.log(`  User:       ${user.email} (password set from FBEDS_SEED_ADMIN_PASSWORD, not printed)`);
  console.log(`  Membership: owner`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
