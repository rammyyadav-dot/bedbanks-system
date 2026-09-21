import { PrismaClient } from '@prisma/client'

describe('platform database context isolation', () => {
  const prisma = new PrismaClient()

  afterAll(async () => prisma.$disconnect())

  it('does not leak sequential platform context', async () => {
    const first = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_access', 'true', true)`
      await tx.$executeRaw`SELECT set_config('app.platform_operator_id', ${'operator-a'}, true)`
      return tx.$queryRaw<Array<{ access: string; operator_id: string }>>`SELECT current_setting('app.platform_access', true) AS access, current_setting('app.platform_operator_id', true) AS operator_id`
    })
    const second = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_access', 'false', true)`
      await tx.$executeRaw`SELECT set_config('app.platform_operator_id', ${'operator-b'}, true)`
      return tx.$queryRaw<Array<{ access: string; operator_id: string }>>`SELECT current_setting('app.platform_access', true) AS access, current_setting('app.platform_operator_id', true) AS operator_id`
    })
    expect(first[0]).toEqual({ access: 'true', operator_id: 'operator-a' })
    expect(second[0]).toEqual({ access: 'false', operator_id: 'operator-b' })
  })

  it('does not leak concurrent platform context across transactions', async () => {
    const readContext = (operatorId: string, access: string, delayMs: number) => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_access', ${access}, true)`
      await tx.$executeRaw`SELECT set_config('app.platform_operator_id', ${operatorId}, true)`
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return tx.$queryRaw<Array<{ access: string; operator_id: string }>>`SELECT current_setting('app.platform_access', true) AS access, current_setting('app.platform_operator_id', true) AS operator_id`
    })
    const [first, second] = await Promise.all([readContext('operator-a', 'true', 25), readContext('operator-b', 'false', 5)])
    expect(first[0]).toEqual({ access: 'true', operator_id: 'operator-a' })
    expect(second[0]).toEqual({ access: 'false', operator_id: 'operator-b' })
  })
})
