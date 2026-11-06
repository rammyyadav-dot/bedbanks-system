/**
 * Owner-run provisioning of the narrow booking execution role (ADR 0113). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   BOOKING_EXECUTION_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-booking-execution-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build BOOKING_EXECUTION_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { BOOKING_EXECUTION_GROUP_ROLE, BOOKING_EXECUTION_LOGIN_ROLE, provisionBookingExecutionRole } from './booking-execution-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.BOOKING_EXECUTION_LOGIN_PASSWORD
  const loginRole = process.env.BOOKING_EXECUTION_LOGIN_ROLE ?? BOOKING_EXECUTION_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and BOOKING_EXECUTION_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionBookingExecutionRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${BOOKING_EXECUTION_GROUP_ROLE}) on database "${target.database}": the agent booking transaction only (hold, booking, ledger append, named counter columns). No price, credit-limit, allotment, credential or identity write, and no DELETE (ADR 0113).`)
    console.log('Build BOOKING_EXECUTION_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
