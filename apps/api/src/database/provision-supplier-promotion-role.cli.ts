/**
 * Owner-run provisioning of the narrow supplier promotion role (ADR 0084). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   SUPPLIER_PROMOTION_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-supplier-promotion-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build SUPPLIER_PROMOTION_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { PROMOTE_GROUP_ROLE, PROMOTE_LOGIN_ROLE, provisionPromoteRole } from './supplier-promotion-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.SUPPLIER_PROMOTION_LOGIN_PASSWORD
  const loginRole = process.env.SUPPLIER_PROMOTION_LOGIN_ROLE ?? PROMOTE_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and SUPPLIER_PROMOTION_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionPromoteRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${PROMOTE_GROUP_ROLE}) on database "${target.database}": read and append the promotion run table, write nightly rates, availability and pool capacity through named columns only, read observations and mappings, append audit events (ADR 0084).`)
    console.log('Build SUPPLIER_PROMOTION_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
