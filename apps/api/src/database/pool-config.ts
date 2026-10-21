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
