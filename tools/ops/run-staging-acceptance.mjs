// Disposable-database rehearsal of the staging acceptance checks (ADR 0112).
// Refuses non-loopback databases. Does not deploy, and does not sign the exit gate.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const requireSignoff = process.argv.includes('--require-signoff')
const url = process.env.ACCEPTANCE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/fbeds_ops_accept'
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`refusing non-loopback ACCEPTANCE_DATABASE_URL host '${host}'`)
  process.exit(2)
}
const dbName = new URL(url).pathname.replace(/^\//, '')
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'

const steps = []
function run(name, command, args, env = {}) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  const record = { name, status: result.status ?? 1, seconds: Math.round((Date.now() - started) / 100) / 10 }
  steps.push(record)
  return record.status === 0
}

function psql(databaseUrl, sql) {
  return spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'inherit' }).status === 0
}

const report = {
  kind: 'staging-acceptance-rehearsal',
  database: dbName,
  loopback: true,
  stagingDeploy: 'NOT_RUN',
  stagingDeployReason: 'Staging promotion runs from main when STAGING_PIPELINE_ENABLED is true (ADR 0090). This rehearsal has no AWS credentials and does not dispatch a deploy.',
  steps,
}

run('architecture', 'pnpm', ['check:architecture'])
run('api-type-check', 'pnpm', ['--filter', '@bedbanks/api', 'type-check'])
run('dependencies', 'pnpm', ['check:dependencies'])
run('ops-unit', 'node', ['--test', 'tools/ops/incident-tabletop.test.mjs', 'tools/ops/staging-signoff.test.mjs', 'tools/ops/privacy-log-review.test.mjs', 'tools/ops/slo-catalog.test.mjs', 'tools/aws-governance-check.test.mjs'])
run('sli-unit', 'pnpm', ['--filter', '@bedbanks/api', 'exec', 'jest', 'src/observability/sli.spec.ts', '--runInBand'])
run('incident-tabletop', 'node', ['tools/ops/incident-tabletop.mjs'])
run('privacy-review', 'node', ['tools/ops/privacy-log-review.mjs'])
run('signoff', 'node', ['tools/ops/staging-signoff.mjs', '--sha', '0'.repeat(40)])

const prepared = psql(adminUrl.toString(), `DROP DATABASE IF EXISTS "${dbName}"`) && psql(adminUrl.toString(), `CREATE DATABASE "${dbName}"`)
steps.push({ name: 'database', status: prepared ? 0 : 1 })
const migrated = prepared
  && run('prisma-generate', 'pnpm', ['--filter', '@bedbanks/api', 'prisma:generate'])
  && run('migrate', 'pnpm', ['--filter', '@bedbanks/api', 'prisma:migrate:deploy'], { DATABASE_URL: url })
if (migrated) {
  run('restore-drill', 'tools/ops/restore-drill.sh', [], { SOURCE_URL: url })
  run('tenant-authorization', 'pnpm', ['--filter', '@bedbanks/api', 'test:security'], { DATABASE_URL: url, NODE_ENV: 'test' })
  run('inventory-concurrency', 'pnpm', ['--filter', '@bedbanks/api', 'exec', 'jest', '--config', './test/jest-e2e.json', '--runInBand', 'test/inventory-hold.e2e-spec.ts', '-t', 'allows exactly|converges 25 identical idempotent'], {
    DATABASE_URL: url,
    NODE_ENV: 'test',
  })
  run('booking-idempotency', 'pnpm', ['--filter', '@bedbanks/api', 'exec', 'jest', '--config', './test/jest-e2e.json', '--runInBand', 'test/booking-confirmation.e2e-spec.ts', '-t', 'idempotent|simultaneous confirmations'], {
    DATABASE_URL: url,
    NODE_ENV: 'test',
  })
  const seeded = run('search-seed', 'node', ['--import', 'tsx', 'tools/load/seed-hotel-search-corpus.ts'], {
    LOADTEST_DATABASE_URL: url,
    LOADTEST_ROWS: process.env.LOADTEST_ROWS ?? '10000',
  })
  if (seeded) {
    const tenant = spawnSync('psql', [url, '-X', '-At', '-c', 'SELECT "tenant_id" FROM "HotelSearchIndex" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1'], { encoding: 'utf8' })
    const tenantId = (tenant.stdout ?? '').trim()
    steps.push({ name: 'search-tenant', status: tenantId ? 0 : 1 })
    if (tenantId) {
      run('search-load', 'node', ['--import', 'tsx', 'tools/load/hybrid-search-load.ts'], {
        LOADTEST_DATABASE_URL: url,
        LOADTEST_TENANT_ID: tenantId,
        LOADTEST_MIN_ROWS: process.env.LOADTEST_MIN_ROWS ?? '10000',
        LOADTEST_STEPS: process.env.LOADTEST_STEPS ?? '1,8',
        LOADTEST_DURATION_S: process.env.LOADTEST_DURATION_S ?? '8',
      })
    }
  }
}

const recorded = new Set(['signoff', 'search-seed', 'search-load', 'search-tenant'])
report.searchBudget = steps.some((step) => step.name === 'search-load' && step.status === 0) ? 'MET' : 'NOT_MET'

mkdirSync(`${root}/docs/evidence/staging-acceptance`, { recursive: true })
writeFileSync(`${root}/docs/evidence/staging-acceptance/rehearsal.json`, `${JSON.stringify(report, null, 2)}\n`)
const failed = steps.filter((step) => !recorded.has(step.name) && step.status !== 0)
console.log(JSON.stringify({ wrote: 'docs/evidence/staging-acceptance/rehearsal.json', failed: failed.map((step) => step.name), signoff: steps.find((step) => step.name === 'signoff')?.status }))
if (failed.length) process.exit(1)
process.exit(requireSignoff && steps.find((step) => step.name === 'signoff')?.status !== 0 ? 2 : 0)
