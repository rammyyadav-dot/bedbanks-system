/**
 * Owner-run provisioning of the narrow Agent booking transaction role (ADR 0113). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   BOOKING_TRANSACTION_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-booking-transaction-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build BOOKING_TRANSACTION_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { BOOKTX_GROUP_ROLE, BOOKTX_LOGIN_ROLE, provisionBooktxRole } from './booking-transaction-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.BOOKING_TRANSACTION_LOGIN_PASSWORD
  const loginRole = process.env.BOOKING_TRANSACTION_LOGIN_ROLE ?? BOOKTX_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and BOOKING_TRANSACTION_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionBooktxRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${BOOKTX_GROUP_ROLE}) on database "${target.database}": Agent booking, hold, ledger and document mutations only. The API runtime role is unchanged.`)
    console.log('Build BOOKING_TRANSACTION_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
