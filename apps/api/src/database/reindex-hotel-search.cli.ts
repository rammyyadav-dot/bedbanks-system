/**
 * Owner-run HotelSearchIndex (re)population. DRY RUN BY DEFAULT.
 *
 *   HOTEL_SEARCH_REINDEX_DATABASE_URL=<narrow reindex credential, ADR 0096> \
 *   pnpm --filter @bedbanks/api ops:reindex-hotel-search [--tenant=<id>] [--apply] [--fail-on-stale] [--allow-remote --confirm-database=<name>]
 *
 * Exit codes: 0 ok, 2 applied rows did not reconcile, 3 --fail-on-stale and indexable hotels remain stale (use a dry run as a freshness gate).
 * Prefers the narrow reindex login (ops:provision-hotel-search-reindex-role). MIGRATION_DATABASE_URL (the schema owner) is the fallback for a first run before that role exists.
 * Prints a JSON report (counts and hotel ids only). Remote targets need the owner's explicit confirmation flags. Use the direct
 * (non-pooled) endpoint. Idempotent: re-running writes only hotels that are missing, changed, or built by another embedding model.
 */
import { PrismaClient } from '@prisma/client'
import { normalizeOpsDatabaseUrl } from './ops-database-url'
import { reindexExitCode, runHotelSearchReindex } from '../mapping/hotel-search-reindex'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const target = normalizeOpsDatabaseUrl(process.env.HOTEL_SEARCH_REINDEX_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL)
  if (target.pooled) throw new Error('Use the direct database endpoint, not the pooled one')
  if (!target.local) {
    const confirmed = args.find((a) => a.startsWith('--confirm-database='))?.slice('--confirm-database='.length)
    if (!args.includes('--allow-remote') || confirmed !== target.database) throw new Error('Remote target: pass --allow-remote and --confirm-database=<exact database name> after the owner has approved this run')
  }
  const tenant = args.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length)
  const prisma = new PrismaClient({ datasourceUrl: target.url })
  try {
    const report = await runHotelSearchReindex(prisma, { apply: args.includes('--apply'), tenantIds: tenant ? [tenant] : undefined })
    console.log(JSON.stringify({ database: target.database, ...report }, null, 2))
    process.exitCode = reindexExitCode(report, { failOnStale: args.includes('--fail-on-stale') })
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Reindex failed')
  process.exit(1)
})
