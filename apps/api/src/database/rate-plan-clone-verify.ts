import { isDatabasePermissionDenied } from './db-errors'
import { verifyRatePlanCloneRole, type RatePlanCloneRoleReport } from './rate-plan-clone-role'

type Executor = { $queryRawUnsafe<T = unknown>(query: string): Promise<T>; $executeRawUnsafe(query: string): Promise<number> }

export interface RatePlanCloneProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface RatePlanCloneProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/**
 * Privilege probes for the clone login (ADR 0057, S8). Every statement is `WHERE false` (or inserts no row), so PostgreSQL decides on privilege at
 * plan time and no row is read or written: safe to run against a hosted database with the clone credential alone. The DRAFT-only trigger is a row
 * rule and is proven by the database test; the verifier checks that it exists and is enabled.
 */
export const RATE_PLAN_CLONE_PROBES: readonly RatePlanCloneProbe[] = [
  { name: 'SELECT RatePlan', sql: `SELECT "id", "status" FROM "RatePlan" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Contract', sql: `SELECT "id" FROM "Contract" WHERE false`, expect: 'allowed' },
  { name: 'SELECT RoomType', sql: `SELECT "id" FROM "RoomType" WHERE false`, expect: 'allowed' },
  { name: 'INSERT RatePlan', sql: `INSERT INTO "RatePlan" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE RatePlan.status', sql: `UPDATE "RatePlan" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE RatePlan.code', sql: `UPDATE "RatePlan" SET "code" = "code" WHERE false`, expect: 'denied' },
  { name: 'DELETE RatePlan', sql: `DELETE FROM "RatePlan" WHERE false`, expect: 'denied' },
  { name: 'INSERT DailyRate', sql: `INSERT INTO "DailyRate" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'INSERT DailyAvailability', sql: `INSERT INTO "DailyAvailability" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT DailyRate', sql: `SELECT "amount_minor" FROM "DailyRate" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Contract', sql: `UPDATE "Contract" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT Hotel id and tenant', sql: `SELECT "id", "tenant_id" FROM "Hotel" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Hotel.name', sql: `SELECT "name" FROM "Hotel" WHERE false`, expect: 'denied' },
  { name: 'SELECT tenants', sql: `SELECT "id" FROM "tenants" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking', sql: `SELECT "id" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'SELECT Wallet', sql: `SELECT "id" FROM "Wallet" WHERE false`, expect: 'denied' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runRatePlanCloneProbes(db: Executor): Promise<RatePlanCloneProbeResult[]> {
  const results: RatePlanCloneProbeResult[] = []
  for (const probe of RATE_PLAN_CLONE_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface RatePlanCloneCertification { ok: boolean; role: RatePlanCloneRoleReport; probes: RatePlanCloneProbeResult[] }

/** Run while connected AS the clone login. Read-only. */
export async function certifyRatePlanCloneRole(db: Executor): Promise<RatePlanCloneCertification> {
  const role = await verifyRatePlanCloneRole(db)
  const probes = await runRatePlanCloneProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
