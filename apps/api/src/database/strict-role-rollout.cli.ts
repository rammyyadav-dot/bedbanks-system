/**
 * Read-only rollout checks for the strict API runtime role. See docs/runbooks/strict-role-rollout.md.
 *
 *   # owner credential: what would a rollout change? (never writes)
 *   PROVISION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api ops:strict-role-rollout status [--allow-remote --confirm-database=<name>]
 *
 *   # runtime login credential: does the provisioned role match the contract? (never writes)
 *   API_DATABASE_URL=<runtime login url> pnpm --filter @bedbanks/api ops:strict-role-rollout verify [--allow-remote --confirm-database=<name>]
 *
 * Prints role, database and migration names and findings only; never a URL or password. Exit code 1 when BLOCKED or not ok.
 */
import { readdirSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { checkTarget } from './provision-hold-expiry-role.cli'
import { rolloutStatus, rolloutVerify } from './strict-role-rollout'

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'status') {
    const url = process.env.PROVISION_DATABASE_URL
    if (!url) throw new Error('PROVISION_DATABASE_URL (the owner connection) is required')
    const target = checkTarget(url, rest)
    const repo = readdirSync(join(__dirname, '..', '..', 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    const prisma = new PrismaClient({ datasourceUrl: url })
    try {
      const s = await rolloutStatus(prisma, repo, { host: target.host })
      console.log(`Database: ${target.database}`)
      console.log(`Migrations: ${s.migrations.applied.length} applied, ${s.migrations.pending.length} pending${s.migrations.pending.length ? ` (${s.migrations.pending.join(', ')})` : ''}, ${s.migrations.unfinished.length} unfinished, ${s.migrations.unknown.length} unknown, ${s.migrations.rolledBack.length} rolled back (ignored)`)
      console.log(`Group role: ${s.roles.groupExists ? 'present' : 'absent'}; login members: ${s.roles.loginRoles.map((l) => l.role).join(', ') || 'none'}`)
      console.log(s.grantDrift.length ? `Grant drift (${s.grantDrift.length}):\n${s.grantDrift.map((d) => `  - ${d}`).join('\n')}` : 'Grant drift: none')
      for (const b of s.blockers) console.log(`BLOCKER: ${b}`)
      console.log('Next steps (run by the database owner):'); s.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`))
      console.log(`Verdict: ${s.verdict}`)
      if (s.verdict === 'BLOCKED') process.exitCode = 1
    } finally { await prisma.$disconnect() }
  } else if (mode === 'verify') {
    const url = process.env.API_DATABASE_URL
    if (!url) throw new Error('API_DATABASE_URL (the runtime login connection) is required')
    const target = checkTarget(url, rest)
    const prisma = new PrismaClient({ datasourceUrl: url })
    try {
      const r = await rolloutVerify(prisma as never)
      console.log(`Database: ${target.database}`)
      for (const f of r.roleFailures) console.log(`ROLE: ${f}`)
      for (const p of r.probes) console.log(`${p.ok ? 'PASS' : 'FAIL'}  ${p.name} (expected ${p.expected}, was ${p.actual})`)
      console.log(`Result: ${r.ok ? 'OK' : 'NOT OK'}`)
      if (!r.ok) process.exitCode = 1
    } finally { await prisma.$disconnect() }
  } else {
    throw new Error('usage: ops:strict-role-rollout status|verify [--allow-remote --confirm-database=<name>]')
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Rollout check failed'); process.exit(1) })
}
