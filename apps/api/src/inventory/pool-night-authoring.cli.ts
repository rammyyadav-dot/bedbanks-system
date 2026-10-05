/**
 * Owner-run: create missing pool stock rows (ADR 0036 Amendment 2). Preview by default; --apply writes.
 *
 *   PROVISION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api ops:pool-nights \
 *     --tenant=<id> --pool=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD --capacity=<n> --reason="..." --actor="<who runs this>" \
 *     [--apply [--expect=<fingerprint from the preview>]] [--allow-remote --confirm-database=<name>]
 *
 * Creates only nights that have no row (never updates an existing night, sold or held). Prints names, counts and a fingerprint; never a URL or password.
 */
import { PrismaClient } from '@prisma/client'
import { checkTarget } from '../database/provision-hold-expiry-role.cli'
import { authorPoolNights } from './pool-night-authoring'

const arg = (name: string): string | undefined => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

async function main(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  if (!url) throw new Error('PROVISION_DATABASE_URL (the owner connection) is required')
  const target = checkTarget(url, process.argv.slice(2))
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    const r = await authorPoolNights(prisma, {
      tenantId: arg('tenant') ?? '', poolId: arg('pool') ?? '', from: arg('from') ?? '', to: arg('to') ?? '', capacity: Number(arg('capacity')), reason: arg('reason') ?? '', actor: arg('actor') ?? '',
    }, { apply, expectedFingerprint: arg('expect') })
    console.log(`Database: ${target.database}; pool "${r.poolName}"`)
    console.log(`${apply ? 'Created' : 'Would create'} ${apply ? r.created : r.plan.create.length} night(s); ${r.plan.existing.length} already exist (untouched); ${r.plan.past.length} before the hotel-local today (skipped).`)
    if (!apply) console.log(`Fingerprint: ${r.plan.fingerprint}\nTo apply: re-run with --apply --expect=${r.plan.fingerprint}`)
  } finally { await prisma.$disconnect() }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Pool night authoring failed'); process.exit(1) })
}
