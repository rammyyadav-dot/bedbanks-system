import { createHash, randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'

export interface StagingScope { tenantId: string; supplierId: string; connectorId: string; correlationId: string }
export type StagingCode = 'INVALID_INPUT' | 'SCOPE_DENIED' | 'SANDBOX_CONNECTOR_REQUIRED' | 'LEASE_LOST' | 'CHECKPOINT_CONFLICT' | 'PARAMETER_CONFLICT' | 'PAGE_CONFLICT' | 'QUARANTINED' | 'DATABASE_UNAVAILABLE'
export class SandboxStagingError extends Error {
  readonly code: StagingCode
  constructor(code: StagingCode) { super('Sandbox content staging failed'); this.code = code; this.name = 'SandboxStagingError' }
}
export const SANDBOX_STAGING_GROUP = 'fbeds_sandbox_staging'
export const STAGING_UPDATE_COLUMNS = {
  SandboxContentRun: ['next_from', 'status', 'attempt_count', 'page_count', 'last_attempt_at', 'last_success_at', 'error_classification', 'updated_at'],
  SandboxContentLease: ['token', 'expires_at', 'generation'],
} as const
/** One statement source for the separate operator principal. No API grant changes. */
export function sandboxStagingGrantSql(role = SANDBOX_STAGING_GROUP): string[] {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error('Invalid sandbox role name')
  const q = '"' + role + '"'
  return [
    `GRANT USAGE ON SCHEMA public TO ${q}`,
    `GRANT EXECUTE ON FUNCTION "fbeds_current_tenant_id"() TO ${q}`,
    `GRANT SELECT ("id", "tenant_id", "supplier_id", "type", "status", "transport_metadata") ON "ConnectorDefinition" TO ${q}`,
    ...['SandboxContentRun', 'SandboxContentPage', 'SandboxContentLease'].map(t => `GRANT SELECT, INSERT ON "${t}" TO ${q}`),
    ...Object.entries(STAGING_UPDATE_COLUMNS).map(([t, cols]) => `GRANT UPDATE (${cols.map(c => '"' + c + '"').join(', ')}) ON "${t}" TO ${q}`),
    `GRANT INSERT ON "AuditEvent" TO ${q}`,
  ]
}
function fail(code: StagingCode): never { throw new SandboxStagingError(code) }
function identifier(value: string): void { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT') }
export function stagingParameterHash(lastUpdateTime: string | null): string {
  if (lastUpdateTime !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(lastUpdateTime) || !Number.isFinite(Date.parse(lastUpdateTime)) ||
      new Date(lastUpdateTime).toISOString().slice(0, 10) !== lastUpdateTime)) fail('INVALID_INPUT')
  return createHash('sha256').update(JSON.stringify({ environment: 'sandbox', provider: 'hotelbeds', pageSize: 100, language: 'ENG', lastUpdateTime })).digest('hex')
}
function canonical(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (depth > 20) fail('INVALID_INPUT')
  if (value === null) return null as unknown as Prisma.InputJsonValue
  if (typeof value === 'string') { if (value.length > 20000) fail('INVALID_INPUT'); return value }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_INPUT'); return value }
  if (Array.isArray(value)) { if (value.length > 1000) fail('INVALID_INPUT'); return value.map(v => canonical(v, depth + 1)) }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT')
  const out: Record<string, Prisma.InputJsonValue | null> = {}
  const keys = Object.keys(value)
  if (keys.length > 200) fail('INVALID_INPUT')
  for (const key of keys.sort()) {
    if (/api.?key|secret|token|password|authorization|signature|rate.?key|booking|holder|paxes/i.test(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_INPUT')
    out[key] = canonical((value as Record<string, unknown>)[key], depth + 1)
  }
  return out
}
export function stagingPagePayload(hotels: unknown[]): { hotels: Prisma.InputJsonValue; payloadHash: string } {
  if (!Array.isArray(hotels) || hotels.length > 100) fail('INVALID_INPUT')
  const codes: number[] = []
  for (const hotel of hotels) {
    if (!hotel || typeof hotel !== 'object' || Array.isArray(hotel) || !Number.isSafeInteger((hotel as { code?: unknown }).code) ||
        ((hotel as { code: number }).code <= 0)) fail('INVALID_INPUT')
    codes.push((hotel as { code: number }).code)
  }
  if (new Set(codes).size !== codes.length) fail('INVALID_INPUT')
  const safe = canonical(hotels)
  const bytes = JSON.stringify(safe)
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) fail('INVALID_INPUT')
  return { hotels: safe, payloadHash: createHash('sha256').update(bytes).digest('hex') }
}
export async function verifySandboxStagingPrincipal(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<Array<{ unsafe: boolean }>>`
    SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace
    )) AS unsafe FROM pg_roles r WHERE r.rolname = current_user`
  if (rows.length !== 1 || rows[0].unsafe) fail('SCOPE_DENIED')
}

/** Operator-only. Not registered in AppModule and no public HTTP route exists.
 * DB credentials must belong to the separately provisioned staging principal.
 */
export class SandboxContentStore {
  private readonly db: PrismaClient
  private readonly scope: StagingScope
  constructor(db: PrismaClient, scope: StagingScope) {
    Object.values(scope).forEach(identifier)
    this.db = db
    this.scope = Object.freeze({ ...scope })
  }
  private validate(scope: StagingScope): void {
    for (const key of ['tenantId', 'supplierId', 'connectorId'] as const) if (scope[key] !== this.scope[key]) fail('SCOPE_DENIED')
    identifier(scope.correlationId)
  }
  private async transaction<T>(scope: StagingScope, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    this.validate(scope)
    try {
      return await this.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${scope.tenantId}, true)`
        const connectors = await tx.$queryRaw<Array<{ type: string; status: string; metadata: unknown }>>`
          SELECT "type", "status", "transport_metadata" AS metadata FROM "ConnectorDefinition"
          WHERE "id" = ${scope.connectorId} AND "tenant_id" = ${scope.tenantId} AND "supplier_id" = ${scope.supplierId}`
        const connector = connectors[0]
        const meta = connector?.metadata as { environment?: unknown; provider?: unknown } | undefined
        if (!connector || connector.type !== 'API_JSON' || !['DRAFT', 'ACTIVE'].includes(connector.status) ||
            meta?.environment !== 'sandbox' || meta.provider !== 'hotelbeds') fail('SANDBOX_CONNECTOR_REQUIRED')
        return work(tx)
      }, { timeout: 15000, maxWait: 5000 })
    } catch (error) {
      if (error instanceof SandboxStagingError) throw error
      fail('DATABASE_UNAVAILABLE')
    }
  }
  private async audit(tx: Prisma.TransactionClient, scope: StagingScope, action: string, runId: string, payload: Prisma.InputJsonObject): Promise<void> {
    const payloadJson = JSON.stringify({ ...payload, correlationId: scope.correlationId })
    await tx.$executeRaw`INSERT INTO "AuditEvent" ("id", "tenant_id", "actor_type", "action", "entity_type", "entity_id", "payload")
      VALUES (${randomUUID()}, ${scope.tenantId}, 'SYSTEM', ${'sandbox.content.' + action}, 'sandbox_content_run', ${runId}, ${payloadJson}::jsonb)`
  }
  private async lockLease(tx: Prisma.TransactionClient, scope: StagingScope, token: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ token: string }>>`SELECT "token" FROM "SandboxContentLease"
      WHERE "tenant_id" = ${scope.tenantId} AND "connector_id" = ${scope.connectorId}
      AND "token" = ${token} AND "expires_at" > clock_timestamp() FOR UPDATE`
    if (rows.length !== 1) fail('LEASE_LOST')
  }
  async checkpoint(scope: StagingScope, runId: string, lastUpdateTime: string | null, leaseToken: string): Promise<number> {
    identifier(runId)
    const hash = stagingParameterHash(lastUpdateTime)
    return this.transaction(scope, async tx => {
      await this.lockLease(tx, scope, leaseToken)
      // INSERT once; parameters are immutable, not changed by an upsert.
      await tx.sandboxContentRun.createMany({ data: [{ id: runId, tenantId: scope.tenantId, supplierId: scope.supplierId,
        connectorId: scope.connectorId, parameterHash: hash, lastUpdateTime }], skipDuplicates: true })
      await tx.$queryRaw`SELECT "id" FROM "SandboxContentRun" WHERE "id" = ${runId} AND "tenant_id" = ${scope.tenantId} FOR UPDATE`
      const run = await tx.sandboxContentRun.findFirst({ where: { id: runId, tenantId: scope.tenantId, connectorId: scope.connectorId, supplierId: scope.supplierId } })
      if (!run || run.parameterHash !== hash) fail('PARAMETER_CONFLICT')
      if (run.status === 'QUARANTINED' || run.attemptCount >= 5) fail('QUARANTINED')
      await tx.sandboxContentRun.update({ where: { id: run.id }, data: { attemptCount: { increment: 1 }, status: 'PROCESSING', lastAttemptAt: new Date(), errorClassification: null } })
      await this.audit(tx, scope, 'attempted', runId, { nextFrom: run.nextFrom, attempt: run.attemptCount + 1 })
      return run.nextFrom
    })
  }
  async acquire(key: string, ttlMs: number): Promise<{ key: string; token: string } | null> {
    const expected = `fbeds:sandbox-content:${this.scope.tenantId}:${this.scope.supplierId}:${this.scope.connectorId}`
    if (key !== expected || ttlMs !== 60000) fail('INVALID_INPUT')
    const token = randomUUID()
    return this.transaction(this.scope, async tx => {
      const rows = await tx.$queryRaw<Array<{ token: string }>>`
        INSERT INTO "SandboxContentLease" ("tenant_id", "supplier_id", "connector_id", "token", "expires_at", "generation")
        VALUES (${this.scope.tenantId}, ${this.scope.supplierId}, ${this.scope.connectorId}, ${token}, clock_timestamp() + interval '60 seconds', 1)
        ON CONFLICT ("tenant_id", "connector_id") DO UPDATE
          SET "token" = EXCLUDED."token", "expires_at" = EXCLUDED."expires_at", "generation" = "SandboxContentLease"."generation" + 1
          WHERE "SandboxContentLease"."expires_at" IS NULL OR "SandboxContentLease"."expires_at" <= clock_timestamp()
        RETURNING "token"`
      return rows.length ? { key, token } : null
    })
  }
  async release(lease: { key: string; token: string }): Promise<void> {
    const expected = `fbeds:sandbox-content:${this.scope.tenantId}:${this.scope.supplierId}:${this.scope.connectorId}`
    if (lease.key !== expected) fail('INVALID_INPUT')
    await this.transaction(this.scope, async tx => {
      await tx.sandboxContentLease.updateMany({ where: { tenantId: this.scope.tenantId, connectorId: this.scope.connectorId, token: lease.token }, data: { token: null, expiresAt: null } })
    })
  }
  async commitPage(scope: StagingScope, input: { runId: string; lastUpdateTime: string | null; leaseToken: string; expectedFrom: number; nextFrom: number; hotels: unknown[]; receivedAt: string }): Promise<void> {
    identifier(input.runId)
    if (!Number.isSafeInteger(input.expectedFrom) || !Number.isSafeInteger(input.nextFrom) ||
        input.expectedFrom < 1 || input.nextFrom <= input.expectedFrom || input.nextFrom - input.expectedFrom > 100 ||
        !Number.isFinite(Date.parse(input.receivedAt))) fail('INVALID_INPUT')
    const payload = stagingPagePayload(input.hotels)
    const parameters = stagingParameterHash(input.lastUpdateTime)
    await this.transaction(scope, async tx => {
      const leases = await tx.$queryRaw<Array<{ token: string }>>`
        SELECT "token" FROM "SandboxContentLease" WHERE "tenant_id" = ${scope.tenantId} AND "connector_id" = ${scope.connectorId}
        AND "token" = ${input.leaseToken} AND "expires_at" > clock_timestamp() FOR UPDATE`
      if (leases.length !== 1) fail('LEASE_LOST')
      await tx.$queryRaw`SELECT "id" FROM "SandboxContentRun" WHERE "id" = ${input.runId} AND "tenant_id" = ${scope.tenantId} FOR UPDATE`
      const run = await tx.sandboxContentRun.findFirst({ where: { id: input.runId, tenantId: scope.tenantId, connectorId: scope.connectorId, supplierId: scope.supplierId } })
      if (!run || run.parameterHash !== parameters) fail('PARAMETER_CONFLICT')
      const existing = await tx.sandboxContentPage.findUnique({ where: { runId_from: { runId: run.id, from: input.expectedFrom } } })
      if (existing) {
        if (existing.payloadHash !== payload.payloadHash || existing.nextFrom !== input.nextFrom) fail('PAGE_CONFLICT')
        return // Same committed page replays without another checkpoint advance or audit.
      }
      if (run.status !== 'PROCESSING' || run.nextFrom !== input.expectedFrom) fail('CHECKPOINT_CONFLICT')
      await tx.sandboxContentPage.create({ data: { id: randomUUID(), tenantId: scope.tenantId, runId: run.id, from: input.expectedFrom, nextFrom: input.nextFrom,
        payloadHash: payload.payloadHash, hotels: payload.hotels, receivedAt: new Date(input.receivedAt) } })
      await tx.sandboxContentRun.update({ where: { id: run.id }, data: { nextFrom: input.nextFrom, pageCount: { increment: 1 }, lastSuccessAt: new Date(), errorClassification: null } })
      await this.audit(tx, scope, 'page_staged', run.id, { from: input.expectedFrom, nextFrom: input.nextFrom, records: input.hotels.length, payloadHash: payload.payloadHash })
      const stillHeld = await tx.$queryRaw<Array<{ n: number }>>`SELECT 1 AS n FROM "SandboxContentLease" WHERE "tenant_id" = ${scope.tenantId}
        AND "connector_id" = ${scope.connectorId} AND "token" = ${input.leaseToken} AND "expires_at" > clock_timestamp()`
      if (stillHeld.length !== 1) fail('LEASE_LOST')
    })
  }
  async finish(scope: StagingScope, input: { runId: string; complete: boolean; leaseToken: string }): Promise<void> {
    const { runId, complete, leaseToken } = input
    identifier(runId)
    await this.transaction(scope, async tx => {
      await this.lockLease(tx, scope, leaseToken)
      const changed = await tx.sandboxContentRun.updateMany({ where: { id: runId, tenantId: scope.tenantId, supplierId: scope.supplierId, connectorId: scope.connectorId, status: 'PROCESSING' },
        data: { status: complete ? 'SUCCEEDED' : 'PENDING' } })
      if (changed.count !== 1) fail('CHECKPOINT_CONFLICT')
      await this.audit(tx, scope, complete ? 'completed' : 'paused', runId, {})
    })
  }
  async recordFailure(scope: StagingScope, runId: string, classification: string, leaseToken: string): Promise<void> {
    identifier(runId)
    if (!['authentication_or_quota', 'rate_limited', 'timeout', 'cancelled', 'transport', 'provider_unavailable', 'malformed_response', 'unsupported', 'circuit_open', 'DATABASE_UNAVAILABLE'].includes(classification)) fail('INVALID_INPUT')
    await this.transaction(scope, async tx => {
      await this.lockLease(tx, scope, leaseToken)
      const run = await tx.sandboxContentRun.findFirst({ where: { id: runId, tenantId: scope.tenantId, connectorId: scope.connectorId, supplierId: scope.supplierId } })
      if (!run) fail('SCOPE_DENIED')
      const status = run.attemptCount >= 5 ? 'QUARANTINED' : 'FAILED'
      await tx.sandboxContentRun.update({ where: { id: run.id }, data: { status, errorClassification: classification } })
      await this.audit(tx, scope, 'failed', runId, { classification, status })
    })
  }
}

