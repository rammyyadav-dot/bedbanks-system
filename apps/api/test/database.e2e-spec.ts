import { PrismaClient } from '@prisma/client';

/**
 * This deliberately uses the CI PostgreSQL service, not a Prisma mock.
 * It proves that committed migrations create a usable database for the API.
 */
describe('PostgreSQL migration integration', () => {
  const prisma = new PrismaClient();
  const slug = `ci-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug } });
    await prisma.$disconnect();
  });

  it('persists and reads an identity record after Prisma migrations deploy', async () => {
    const created = await prisma.tenant.create({
      data: { name: 'CI integration tenant', slug },
    });

    await expect(prisma.tenant.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      id: created.id,
      slug,
      status: 'ACTIVE',
    });
  });
});
