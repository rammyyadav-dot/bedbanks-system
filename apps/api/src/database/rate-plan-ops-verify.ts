import { isDatabasePermissionDenied } from './db-errors'
import { verifyRatePlanOpsRole, type RatePlanOpsRoleReport } from './rate-plan-ops-role'

type Executor = { $queryRawUnsafe<T = unknown>(query: string): Promise<T>; $executeRawUnsafe(query: string): Promise<number> }

export interface RatePlanOpsProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface RatePlanOpsProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/**
 * Privilege probes for the lifecycle login (ADR 0041 Amendment 2). Every statement is `WHERE false` (or selects no row), so PostgreSQL decides on
 * privilege at plan time and no row is read or written: safe to run against a hosted database with the lifecycle credential alone.
 */
export const RATE_PLAN_OPS_PROBES: readonly RatePlanOpsProbe[] = [
  { name: 'UPDATE RatePlan.status', sql: `UPDATE "RatePlan" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE RatePlan.updated_at', sql: `UPDATE "RatePlan" SET "updated_at" = "updated_at" WHERE false`, expect: 'allowed' },
  { name: 'SELECT RatePlan', sql: `SELECT "id", "status" FROM "RatePlan" WHERE false`, expect: 'allowed' },
  { name: 'SELECT DailyRate', sql: `SELECT "amount_minor" FROM "DailyRate" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Hotel identity and time zone', sql: `SELECT "id", "tenant_id", "time_zone" FROM "Hotel" WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE RatePlan.code', sql: `UPDATE "RatePlan" SET "code" = "code" WHERE false`, expect: 'denied' },
  { name: 'UPDATE RatePlan.currency', sql: `UPDATE "RatePlan" SET "currency" = "currency" WHERE false`, expect: 'denied' },
  { name: 'UPDATE RatePlan.inventory_pool_id', sql: `UPDATE "RatePlan" SET "inventory_pool_id" = "inventory_pool_id" WHERE false`, expect: 'denied' },
  { name: 'INSERT RatePlan', sql: `INSERT INTO "RatePlan" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'DELETE RatePlan', sql: `DELETE FROM "RatePlan" WHERE false`, expect: 'denied' },
  { name: 'UPDATE DailyRate', sql: `UPDATE "DailyRate" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'UPDATE DailyAvailability', sql: `UPDATE "DailyAvailability" SET "allotment" = "allotment" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Contract', sql: `UPDATE "Contract" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT Hotel.name', sql: `SELECT "name" FROM "Hotel" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking', sql: `SELECT "id" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'SELECT Wallet', sql: `SELECT "id" FROM "Wallet" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet', sql: `UPDATE "Wallet" SET "cached_balance" = "cached_balance" WHERE false`, expect: 'denied' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runRatePlanOpsProbes(db: Executor): Promise<RatePlanOpsProbeResult[]> {
  const results: RatePlanOpsProbeResult[] = []
  for (const probe of RATE_PLAN_OPS_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface RatePlanOpsCertification { ok: boolean; role: RatePlanOpsRoleReport; probes: RatePlanOpsProbeResult[] }

/** Run while connected AS the lifecycle login. Read-only. */
export async function certifyRatePlanOpsRole(db: Executor): Promise<RatePlanOpsCertification> {
  const role = await verifyRatePlanOpsRole(db)
  const probes = await runRatePlanOpsProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
