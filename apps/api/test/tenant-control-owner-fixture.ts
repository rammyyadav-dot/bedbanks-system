/** Legacy owner-fixture suites test business behavior; strict certification uses the real restricted connection instead. */
import type { Prisma, PrismaClient } from '@prisma/client'
export function tenantControlOwnerFixture(prisma: PrismaClient) {
  const scoped = <T>(operator: string | null, tenant: string | null, work: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(async tx => {
    if(operator){await tx.$executeRaw`SELECT set_config('app.platform_access', 'true', true)`;await tx.$executeRaw`SELECT set_config('app.platform_operator_id', ${operator}, true)`}
    if(tenant)await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
    return work(tx)
  })
  return { configured: () => false, withTenant: <T>(tenant: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => scoped(null,tenant,work), withPlatform: <T>(operator: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => scoped(operator,null,work), withPlatformTenant: <T>(operator: string, tenant: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => scoped(operator,tenant,work) }
}
