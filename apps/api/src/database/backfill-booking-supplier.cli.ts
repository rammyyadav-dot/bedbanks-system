/**
 * Owner-run historical supplier attribution report and backfill (ADR 0061 Amendment 1, D3). DRY RUN BY DEFAULT.
 *
 *   MIGRATION_DATABASE_URL=<owner credential from your secret manager> \
 *   pnpm --filter @bedbanks/api ops:backfill-booking-supplier [--tenant=<id>] [--apply] [--allow-remote --confirm-database=<name>]
 *
 * Prints a JSON reconciliation report (counts and booking ids only; no reference, guest, amount or URL). Writes only with --apply, only to rows whose
 * supplier_id is null, and rolls a tenant back if its result does not reconcile. Remote targets need the owner's explicit confirmation flags.
 */
import { PrismaClient } from '@prisma/client'
import { normalizeOpsDatabaseUrl } from './ops-database-url'
import { runBookingSupplierBackfill } from './booking-supplier-backfill'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const target = normalizeOpsDatabaseUrl(process.env.MIGRATION_DATABASE_URL)
  if (!target.local) {
    const confirmed = args.find((a) => a.startsWith('--confirm-database='))?.slice('--confirm-database='.length)
    if (!args.includes('--allow-remote') || confirmed !== target.database) throw new Error('Remote target: pass --allow-remote and --confirm-database=<exact database name> after the owner has approved this run')
  }
  const apply = args.includes('--apply')
  const tenant = args.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length)
  const prisma = new PrismaClient({ datasourceUrl: target.url })
  try {
    const report = await runBookingSupplierBackfill(prisma, { apply, tenantIds: tenant ? [tenant] : undefined })
    console.log(JSON.stringify({ database: target.database, ...report }, null, 2))
    if (!report.reconciliation.categoriesSumToTotal || !report.reconciliation.appliedEqualsAttributable) process.exitCode = 2
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backfill failed')
  process.exit(1)
})
