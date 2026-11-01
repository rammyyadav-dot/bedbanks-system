/**
 * Concurrency load test for hybrid hotel candidate retrieval (ADR 0009).
 *
 * Drives the production `retrieveHotelCandidates` (pgvector HNSW + pg_trgm) through
 * the same tenant-scoped transaction the API uses, at fixed concurrency steps, and
 * fails if p95/p99 exceed the budget. Read-only: it never writes to the database.
 *
 *   LOADTEST_DATABASE_URL=postgres://fbeds_api:...@<neon-pooled-host>/db?sslmode=require \
 *   LOADTEST_TENANT_ID=<tenant with a realistic HotelSearchIndex corpus> \
 *   node --import tsx tools/load/hybrid-search-load.ts
 *
 * Optional: LOADTEST_STEPS=8,32,64,128  LOADTEST_DURATION_S=30  LOADTEST_BUDGET_MS=200
 *           LOADTEST_MIN_ROWS=100000  LOADTEST_POOL=<connection_limit>
 *
 * Run it from a host in the same region as the Neon endpoint, against the pooled
 * (PgBouncer) connection string and the strict runtime role, or the numbers do not
 * describe production. Results from a tiny corpus are rejected via LOADTEST_MIN_ROWS.
 */
import { PrismaClient } from '@prisma/client'
import { retrieveHotelCandidates } from '../../apps/api/src/mapping/hotel-search-index'

const url = process.env.LOADTEST_DATABASE_URL
const tenantId = process.env.LOADTEST_TENANT_ID
if (!url || !tenantId) {
  console.error('LOADTEST_DATABASE_URL and LOADTEST_TENANT_ID are required (DATABASE_URL is deliberately not read).')
  process.exit(2)
}

const steps = (process.env.LOADTEST_STEPS ?? '8,32,64,128').split(',').map(Number).filter((n) => n > 0)
const durationMs = Number(process.env.LOADTEST_DURATION_S ?? 30) * 1000
const budgetMs = Number(process.env.LOADTEST_BUDGET_MS ?? 200)
const minRows = Number(process.env.LOADTEST_MIN_ROWS ?? 100_000)
const pool = Math.max(...steps)

const dsn = new URL(url)
if (!dsn.searchParams.has('connection_limit')) dsn.searchParams.set('connection_limit', process.env.LOADTEST_POOL ?? String(pool))
const prisma = new PrismaClient({ datasources: { db: { url: dsn.toString() } }, log: ['error'] })

type Sample = { name: string; city: string; countryCode: string }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function typo(name: string): string {
  const i = Math.floor(Math.random() * Math.max(1, name.length - 1))
  return name.slice(0, i) + name.slice(i + 1)
}

async function withTenant<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
    return fn(tx)
  })
}

async function loadSamples(): Promise<{ rows: number; samples: Sample[] }> {
  return withTenant(async (tx) => {
    const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "HotelSearchIndex" WHERE "tenant_id" = ${tenantId}`
    const samples = await tx.$queryRaw<Sample[]>`
      SELECT "normalized_name" AS name, "normalized_city" AS city, "normalized_country_code" AS "countryCode"
        FROM "HotelSearchIndex" TABLESAMPLE SYSTEM (1) WHERE "tenant_id" = ${tenantId} LIMIT 5000`
    return { rows: Number(n), samples }
  })
}

async function runStep(concurrency: number, samples: Sample[]) {
  const latencies: number[] = []
  let errors = 0
  const stopAt = Date.now() + durationMs
  const worker = async () => {
    while (Date.now() < stopAt) {
      const s = samples[Math.floor(Math.random() * samples.length)]
      const started = performance.now()
      try {
        // Half exact-ish, half typo'd, mirroring supplier-observation noise.
        await withTenant((tx) => retrieveHotelCandidates(tx, tenantId!, { name: Math.random() < 0.5 ? s.name : typo(s.name), city: s.city, countryCode: s.countryCode }))
        latencies.push(performance.now() - started)
      } catch {
        errors += 1 // counted, never swallowed: any error fails the run
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  latencies.sort((a, b) => a - b)
  return {
    concurrency,
    requests: latencies.length,
    errors,
    rps: Math.round(latencies.length / (durationMs / 1000)),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
  }
}

async function main() {
  const { rows, samples } = await loadSamples()
  console.log(`corpus: ${rows} HotelSearchIndex rows for tenant; ${samples.length} query samples; budget p95/p99 < ${budgetMs}ms`)
  if (rows < minRows) throw new Error(`corpus has ${rows} rows, below LOADTEST_MIN_ROWS=${minRows}; results would not represent peak traffic`)
  if (samples.length === 0) throw new Error('no samples drawn; corpus too small for TABLESAMPLE')

  // Plan check: confirms whether HNSW is actually used with the tenant/country filter.
  const plan = await withTenant((tx) => tx.$queryRawUnsafe<Array<Record<string, string>>>(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT "hotel_id" FROM "HotelSearchIndex" WHERE "tenant_id" = '${tenantId!.replace(/'/g, "''")}' ORDER BY "embedding" <=> (SELECT "embedding" FROM "HotelSearchIndex" LIMIT 1) LIMIT 20`))
  console.log('plan:\n' + plan.map((r) => Object.values(r)[0]).join('\n'))

  // Warm-up so cold Neon compute / cache does not skew the first step, but report cold start separately.
  await runStep(Math.min(8, pool), samples).catch(() => undefined)

  const results = []
  for (const c of steps) {
    const r = await runStep(c, samples)
    results.push(r)
    console.log(`c=${c} rps=${r.rps} n=${r.requests} err=${r.errors} p50=${r.p50.toFixed(1)} p95=${r.p95.toFixed(1)} p99=${r.p99.toFixed(1)} max=${r.max.toFixed(1)} ms`)
  }
  const failed = results.filter((r) => r.errors > 0 || !(r.p95 < budgetMs) || !(r.p99 < budgetMs))
  console.log(failed.length ? `FAIL at concurrency ${failed.map((r) => r.concurrency).join(', ')}` : `PASS: p95 and p99 under ${budgetMs}ms at every step`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 2 }).finally(() => prisma.$disconnect())
