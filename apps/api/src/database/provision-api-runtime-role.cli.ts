/**
 * Owner-run provisioning of the API runtime role (ADR 0008).
 *
 *   PROVISION_DATABASE_URL=<owner credential> \
 *   API_RUNTIME_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-api-runtime-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match.
 * Prints only the role and database names; never a URL or password.
 */
import { PrismaClient } from '@prisma/client'
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from './api-runtime-role'
import { checkTarget } from './provision-hold-expiry-role.cli'

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.API_RUNTIME_LOGIN_PASSWORD
  const loginRole = process.env.API_RUNTIME_LOGIN_ROLE ?? API_RUNTIME_LOGIN_ROLE
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and API_RUNTIME_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionApiRuntimeRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${API_RUNTIME_GROUP_ROLE}) on database "${target.database}".`)
    console.log('Build the API DATABASE_URL yourself from the same host and database with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
