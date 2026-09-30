/**
 * Owner-run provisioning of the hold-expiry background role (ADR 0005).
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   HOLD_EXPIRY_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-hold-expiry-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match.
 * Prints only the role and database names; never a URL or password.
 */
import { PrismaClient } from '@prisma/client'
import { HOLD_EXPIRY_GROUP_ROLE, provisionHoldExpiryRole } from './hold-expiry-role'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export function checkTarget(rawUrl: string, args: string[]): { host: string; database: string } {
  const url = new URL(rawUrl)
  const database = url.pathname.replace(/^\//, '')
  const remote = !LOCAL_HOSTS.has(url.hostname)
  if (remote) {
    const confirmed = args.find(arg => arg.startsWith('--confirm-database='))?.slice('--confirm-database='.length)
    if (!args.includes('--allow-remote') || confirmed !== database) {
      throw new Error('Remote target: pass --allow-remote and --confirm-database=<exact database name> after the owner has approved this change')
    }
  }
  return { host: url.hostname, database }
}

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.HOLD_EXPIRY_LOGIN_PASSWORD
  const loginRole = process.env.HOLD_EXPIRY_LOGIN_ROLE ?? 'fbeds_hold_expiry_login'
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and HOLD_EXPIRY_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionHoldExpiryRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${HOLD_EXPIRY_GROUP_ROLE}) on database "${target.database}".`)
    console.log('Build HOLD_EXPIRY_DATABASE_URL yourself from the same host and database with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
