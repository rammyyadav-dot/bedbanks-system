import { isPooledHost } from './strict-role-rollout';

export interface PoolConfigReport {
  /** Explicit Prisma `connection_limit`, or null when unset (Prisma then defaults to num_cpus * 2 + 1). */
  connectionLimit: number | null;
  pooledHost: boolean;
  /** Findings only; never contains the URL, host or credentials. */
  warnings: string[];
}

/**
 * ADR 0067: pool size is an operator setting on each role URL. This inspects a
 * URL for the settings the connection budget depends on so a missing one is
 * visible at startup. It never throws and never echoes any part of the URL.
 */
export function inspectPoolConfig(url: string | undefined): PoolConfigReport {
  const report: PoolConfigReport = { connectionLimit: null, pooledHost: false, warnings: [] };
  if (!url) return report;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    report.warnings.push('connection URL could not be parsed for pool settings');
    return report;
  }

  report.pooledHost = isPooledHost(parsed.hostname);

  const raw = parsed.searchParams.get('connection_limit');
  if (raw === null) {
    report.warnings.push('connection_limit is not set; Prisma will default to num_cpus * 2 + 1 connections for this pool');
  } else {
    const parsedLimit = Number(raw);
    if (Number.isInteger(parsedLimit) && parsedLimit >= 1) report.connectionLimit = parsedLimit;
    else report.warnings.push('connection_limit is not a positive integer');
  }

  if (report.pooledHost && parsed.searchParams.get('pgbouncer') !== 'true') {
    report.warnings.push('pooled endpoint without pgbouncer=true; prepared statements will fail under transaction pooling');
  }

  return report;
}

export interface ConnectionBudgetInput {
  /** Running API tasks, at the autoscaling maximum when that is what must be survived. */
  tasks: number;
  /** The database's `max_connections` (Neon: per compute size, or the PgBouncer-side limit when every URL is pooled). */
  maxConnections: number;
  /** Slots kept free for migrations, operators and monitoring. */
  reserved: number;
  /** Role label to connection URL, one entry per pool a task opens. */
  urls: Record<string, string | undefined>;
}

export interface ConnectionBudgetReport {
  verdict: 'WITHIN_BUDGET' | 'OVER_BUDGET' | 'UNPROVEN';
  /** Σ connection_limit across the sized pools, per task. */
  perTask: number;
  worstCase: number;
  available: number;
  pools: Array<{ label: string; connectionLimit: number | null; pooledHost: boolean }>;
  /** Labels and reasons only; never a URL, host or credential. */
  findings: string[];
}

/**
 * ADR 0067 / 0075: worst case is `tasks × Σ connection_limit` and must stay at or below
 * `max_connections - reserved`. A pool without an explicit limit cannot be bounded
 * (Prisma defaults to num_cpus * 2 + 1, and a container may see the host's cores), so the
 * verdict is UNPROVEN rather than a guessed number.
 */
export function assessConnectionBudget(input: ConnectionBudgetInput): ConnectionBudgetReport {
  const findings: string[] = [];
  const pools = Object.entries(input.urls)
    .filter(([, url]) => url !== undefined && url !== '')
    .map(([label, url]) => {
      const pool = inspectPoolConfig(url);
      return { label, connectionLimit: pool.connectionLimit, pooledHost: pool.pooledHost };
    });

  const valid = Number.isInteger(input.tasks) && input.tasks >= 1 && Number.isInteger(input.maxConnections) && input.maxConnections >= 1 && Number.isInteger(input.reserved) && input.reserved >= 0;
  const available = valid ? input.maxConnections - input.reserved : 0;
  const perTask = pools.reduce((sum, pool) => sum + (pool.connectionLimit ?? 0), 0);
  const worstCase = valid ? input.tasks * perTask : 0;

  if (!valid) findings.push('tasks, max-connections and reserved must be whole numbers (tasks and max-connections at least 1)');
  if (valid && available < 1) findings.push('reserved leaves no connections available');
  if (pools.length === 0) findings.push('no database pool URLs were provided');
  for (const pool of pools) {
    if (pool.connectionLimit === null) findings.push(`${pool.label}: connection_limit is missing or invalid, so its share of the budget is unbounded`);
  }

  const unproven = !valid || pools.length === 0 || pools.some((pool) => pool.connectionLimit === null);
  const verdict = unproven ? 'UNPROVEN' : worstCase > available ? 'OVER_BUDGET' : 'WITHIN_BUDGET';
  if (verdict === 'OVER_BUDGET') findings.push(`worst case ${input.tasks} tasks x ${perTask} = ${worstCase} exceeds the ${available} connections available`);

  return { verdict, perTask, worstCase, available, pools, findings };
}
