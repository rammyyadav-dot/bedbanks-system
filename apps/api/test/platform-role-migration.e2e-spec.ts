import { PrismaService } from '../src/database/prisma.service'

describe('platform role permission migration (database)', () => {
  let prisma: PrismaService
  beforeAll(async () => {
    prisma = new PrismaService()
    await prisma.onModuleInit()
  })
  afterAll(async () => prisma.onModuleDestroy())

  it('keeps legacy access permissions and canonical replacement permissions uniquely addressable', async () => {
    const legacy = await prisma.platformPermission.findMany({ where: { key: { in: ['platform.access.read', 'platform.access.manage'] } } })
    const canonical = await prisma.platformPermission.findMany({ where: { key: { in: ['platform.roles.read', 'platform.roles.manage', 'platform.assignments.read', 'platform.assignments.manage'] } } })
    expect(legacy.map(({ key }) => key)).toEqual(expect.arrayContaining(['platform.access.read', 'platform.access.manage']))
    expect(canonical.map(({ key }) => key)).toEqual(expect.arrayContaining(['platform.roles.read', 'platform.roles.manage', 'platform.assignments.read', 'platform.assignments.manage']))

    const duplicatePairs = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT "role_id", "permission_id", COUNT(*)
        FROM "PlatformRolePermission"
        GROUP BY "role_id", "permission_id"
        HAVING COUNT(*) > 1
      ) duplicates
    `
    expect(Number(duplicatePairs[0]?.count ?? 0)).toBe(0)
  })
})
