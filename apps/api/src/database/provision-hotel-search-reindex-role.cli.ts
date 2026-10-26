/**
 * Owner-run provisioning of the narrow hotel search reindex role (ADR 0096). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   HOTEL_SEARCH_REINDEX_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-hotel-search-reindex-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build HOTEL_SEARCH_REINDEX_DATABASE_URL yourself from the same direct (non-pooled) host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { SEARCH_REINDEX_GROUP_ROLE, SEARCH_REINDEX_LOGIN_ROLE, provisionSearchReindexRole } from './hotel-search-reindex-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.HOTEL_SEARCH_REINDEX_LOGIN_PASSWORD
  const loginRole = process.env.HOTEL_SEARCH_REINDEX_LOGIN_ROLE ?? SEARCH_REINDEX_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and HOTEL_SEARCH_REINDEX_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionSearchReindexRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${SEARCH_REINDEX_GROUP_ROLE}) on database "${target.database}": read hotel identity columns and tenant ids, insert and update HotelSearchIndex only (ADR 0096).`)
    console.log('Build HOTEL_SEARCH_REINDEX_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
