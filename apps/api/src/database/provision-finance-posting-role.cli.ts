/**
 * Owner-run provisioning of the narrow finance posting role (ADR 0076). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   BOOKING_FINANCE_POSTING_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-finance-posting-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build BOOKING_FINANCE_POSTING_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { FINPOST_GROUP_ROLE, FINPOST_LOGIN_ROLE, provisionFinpostRole } from './finance-posting-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.BOOKING_FINANCE_POSTING_LOGIN_PASSWORD
  const loginRole = process.env.BOOKING_FINANCE_POSTING_LOGIN_ROLE ?? FINPOST_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and BOOKING_FINANCE_POSTING_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionFinpostRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${FINPOST_GROUP_ROLE}) on database "${target.database}": read and append the finance posting tables, update the workflow columns of a posting under review only, read the booking, event and wallet columns the posting rules need, append ledger and payable entries, append audit events (ADR 0076).`)
    console.log('Build BOOKING_FINANCE_POSTING_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
