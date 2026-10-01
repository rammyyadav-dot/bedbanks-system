/**
 * Owner-run bootstrap of the first tenant, tenant owner and platform operator.
 *
 *   PROVISION_DATABASE_URL=<owner credential> \
 *   BOOTSTRAP_TENANT_NAME='Acme Travel' BOOTSTRAP_TENANT_SLUG=acme-travel \
 *   BOOTSTRAP_ADMIN_EMAIL=you@example.com BOOTSTRAP_ADMIN_NAME='Your Name' \
 *   BOOTSTRAP_ADMIN_PASSWORD=<16+ chars> \
 *   pnpm --filter @bedbanks/api ops:bootstrap-first-admin [--allow-remote --confirm-database=<name>] [--reset-password]
 *
 * Refuses non-local targets unless --allow-remote and --confirm-database match.
 * Prints ids and counts only; never a password, hash or connection string.
 */
import { PrismaClient } from '@prisma/client'
import { bootstrapFirstAdmin } from './bootstrap-first-admin'
import { checkTarget } from './provision-hold-expiry-role.cli'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const url = required('PROVISION_DATABASE_URL')
  const args = process.argv.slice(2)
  const target = checkTarget(url, args)
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    const result = await bootstrapFirstAdmin(prisma, {
      tenantName: required('BOOTSTRAP_TENANT_NAME'),
      tenantSlug: required('BOOTSTRAP_TENANT_SLUG'),
      adminEmail: required('BOOTSTRAP_ADMIN_EMAIL'),
      adminName: required('BOOTSTRAP_ADMIN_NAME'),
      adminPassword: required('BOOTSTRAP_ADMIN_PASSWORD'),
      resetPassword: args.includes('--reset-password'),
    })
    console.log(`Bootstrap complete on database "${target.database}": tenant ${result.tenantId} (${result.tenantCreated ? 'created' : 'existing'}), user ${result.userId} (${result.userCreated ? 'created' : 'existing'}), ${result.tenantPermissions} tenant and ${result.platformPermissions} platform permissions granted.`)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Bootstrap failed'); process.exit(1) })
}
