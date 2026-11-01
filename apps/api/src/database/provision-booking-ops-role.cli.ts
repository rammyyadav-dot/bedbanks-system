/**
 * Owner-run provisioning of the Admin booking module's limited database role (ADR 0039). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   BOOKING_OPS_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-booking-ops-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build BOOKING_OPS_DATABASE_URL yourself from the same host and database with the login role and this password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { BOOKING_OPS_GROUP_ROLE, BOOKING_OPS_LOGIN_ROLE, provisionBookingOpsRole } from './booking-ops-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.BOOKING_OPS_LOGIN_PASSWORD
  const loginRole = process.env.BOOKING_OPS_LOGIN_ROLE ?? BOOKING_OPS_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and BOOKING_OPS_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionBookingOpsRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${BOOKING_OPS_GROUP_ROLE}) on database "${target.database}": SELECT on the booking tables, INSERT on the booking tables and the audit log, UPDATE on named Booking columns only (ADR 0039).`)
    console.log('Build BOOKING_OPS_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
