/**
 * Read-only check of the database connection budget (ADR 0067, amendment in ADR 0094). Connects to nothing.
 *
 *   DATABASE_URL=... BOOKING_OPS_DATABASE_URL=... \
 *   pnpm --filter @bedbanks/api ops:connection-budget --tasks=<max running tasks> --max-connections=<database max_connections> [--reserved=10]
 *
 * Reads every role URL a task opens from the environment (the same variables the service receives), prints role labels and numbers only,
 * never a URL, and exits 1 unless the verdict is WITHIN_BUDGET.
 */
import { assessConnectionBudget } from './pool-config'

/** Owner and provisioning credentials are used by one-shot jobs, not by running tasks. */
const NOT_A_TASK_POOL = /^(PROVISION|MIGRATION|OWNER)_/

function numberFlag(args: string[], name: string, fallback?: number): number {
  const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`)
    return fallback
  }
  return Number(raw)
}

function main(): void {
  const args = process.argv.slice(2)
  const urls: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_DATABASE_URL') || key === 'DATABASE_URL') {
      if (!NOT_A_TASK_POOL.test(key)) urls[key] = value
    }
  }
  const report = assessConnectionBudget({
    tasks: numberFlag(args, 'tasks'),
    maxConnections: numberFlag(args, 'max-connections'),
    reserved: numberFlag(args, 'reserved', 10),
    urls,
  })
  for (const pool of report.pools) console.log(`${pool.label}: connection_limit=${pool.connectionLimit ?? 'unset'}${pool.pooledHost ? ' (pooled endpoint)' : ''}`);
  console.log(`per task ${report.perTask}, worst case ${report.worstCase}, available ${report.available}`);
  for (const finding of report.findings) console.log(`- ${finding}`);
  console.log(`Verdict: ${report.verdict}`);
  if (report.verdict !== 'WITHIN_BUDGET') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'connection budget check failed');
  process.exitCode = 1;
}
