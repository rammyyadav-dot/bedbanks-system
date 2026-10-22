/**
 * Owner-run provisioning of the narrow supplier ingestion role (ADR 0079). Idempotent. Nothing is provisioned by the application.
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   SUPPLIER_INGEST_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-supplier-ingest-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match. Prints only the role and database names; never a URL or password.
 * Build SUPPLIER_INGEST_DATABASE_URL yourself from the same host and database with this login and password; it must differ from DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client'
import { INGEST_GROUP_ROLE, INGEST_LOGIN_ROLE, provisionIngestRole } from './supplier-ingest-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.SUPPLIER_INGEST_LOGIN_PASSWORD
  const loginRole = process.env.SUPPLIER_INGEST_LOGIN_ROLE ?? INGEST_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and SUPPLIER_INGEST_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionIngestRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${INGEST_GROUP_ROLE}) on database "${target.database}": read and append the four ingestion tables, refresh the value columns of an observation only, read the connector status columns, append audit events (ADR 0079).`)
    console.log('Build SUPPLIER_INGEST_DATABASE_URL yourself with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
