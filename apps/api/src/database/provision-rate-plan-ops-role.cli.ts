/**
 * Owner-run provisioning of the narrow rate plan lifecycle role (ADR 0041 Amendment 2). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   RATE_PLAN_OPS_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-rate-plan-ops-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build RATE_PLAN_OPS_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { RATE_PLAN_OPS_GROUP_ROLE, RATE_PLAN_OPS_LOGIN_ROLE, provisionRatePlanOpsRole } from './rate-plan-ops-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.RATE_PLAN_OPS_LOGIN_PASSWORD
  const loginRole = process.env.RATE_PLAN_OPS_LOGIN_ROLE ?? RATE_PLAN_OPS_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and RATE_PLAN_OPS_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionRatePlanOpsRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${RATE_PLAN_OPS_GROUP_ROLE}) on database "${target.database}": UPDATE of RatePlan.status and updated_at only, SELECT on the readiness inputs, INSERT on the audit log (ADR 0041).`)
    console.log('Build RATE_PLAN_OPS_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
