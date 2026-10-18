/**
 * Owner-run provisioning of the nightly ledger integrity role (ADR 0064).
 *
 *   PROVISION_DATABASE_URL=<owner credential from your secret manager> \
 *   LEDGER_AUDIT_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
 *   pnpm --filter @bedbanks/api ops:provision-ledger-audit-role [--allow-remote --confirm-database=<name>]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match.
 * Prints only the role and database names; never a URL or password.
 */
import { PrismaClient } from '@prisma/client'
import { LEDGER_AUDIT_GROUP_ROLE, provisionLedgerAuditRole } from './ledger-audit-role'

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
  const password = process.env.LEDGER_AUDIT_LOGIN_PASSWORD
  const loginRole = process.env.LEDGER_AUDIT_LOGIN_ROLE ?? 'fbeds_ledger_audit_login'
  if (!url || !password) throw new Error('PROVISION_DATABASE_URL and LEDGER_AUDIT_LOGIN_PASSWORD are required')
  const target = checkTarget(url, process.argv.slice(2))
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionLedgerAuditRole(prisma, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${LEDGER_AUDIT_GROUP_ROLE}) on database "${target.database}".`)
    console.log('Build LEDGER_AUDIT_DATABASE_URL yourself from the same host and database with this role and the password, store it in the secret manager, and never commit it.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exit(1) })
}
