/**
 * Read-only certification of the rate plan clone login (ADR 0057, S8), run AS that login. Writes nothing; prints no URL or password.
 *
 *   RATE_PLAN_CLONE_DATABASE_URL=<lifecycle credential from your secret manager> \
 *   pnpm --filter @bedbanks/api ops:verify-rate-plan-clone-role [--allow-remote --confirm-database=<name>]
 *
 * Exit code 0 only if the role verifier and every privilege probe pass. Refuses non-local targets without --allow-remote and the exact database name.
 */
import { PrismaClient } from '@prisma/client'
import { certifyRatePlanCloneRole } from './rate-plan-clone-verify'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.RATE_PLAN_CLONE_DATABASE_URL
  if (!url) throw new Error('RATE_PLAN_CLONE_DATABASE_URL is required')
  if (url === process.env.DATABASE_URL) throw new Error('RATE_PLAN_CLONE_DATABASE_URL must differ from DATABASE_URL')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    const [who] = await prisma.$queryRawUnsafe<Array<{ principal: string }>>('SELECT current_user AS principal')
    const report = await certifyRatePlanCloneRole(prisma)
    console.log(`Database "${target.database}" as login "${who?.principal}"`)
    console.log(`Role verifier: ${report.role.ok ? 'OK' : `FAILED (${report.role.failures.join('; ')})`}`)
    for (const probe of report.probes) console.log(`${probe.ok ? 'PASS' : 'FAIL'}  ${probe.expect === 'allowed' ? 'allowed' : 'denied '}  ${probe.name}`)
    console.log(`Result: ${report.ok ? 'OK' : 'FAILED'}`)
    if (!report.ok) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Verification failed'); process.exit(1) })
}
