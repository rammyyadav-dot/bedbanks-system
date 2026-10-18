import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ComplianceArchiveConflict, sha256Hex, type ComplianceArchive } from './compliance-archive'

/**
 * Compliance exporter (ADR 0067): seals each scope's unexported compliance records into hash-chained batches and stores every batch in WORM storage.
 *
 * Two phases, so a crash never forks the chain:
 *   1. seal   (one transaction, scope advisory lock): pick the next records, render the batch, insert the batch row as SEALED with its hashes and its
 *             record membership. The unique (scope, sequence) and unique record_id keys make a second concurrent sealer fail instead of forking.
 *   2. store  render the batch again from its immutable records, check it still hashes to body_sha256, put body and manifest (write-once, idempotent),
 *             then flip SEALED -> STORED. A batch left SEALED by a crash is stored first on the next run, before anything new is sealed.
 *
 * The batch body is NDJSON, one record per line, keys in a fixed order. `payloadText` is the audit payload's jsonb text exactly as the capture trigger
 * hashed it, so `sha256(payloadText) === payloadSha256` can be checked by anyone holding the object, without the database.
 */
export const COMPLIANCE_FORMAT_VERSION = 1
export const GENESIS_SHA256 = '0'.repeat(64)
export const PLATFORM_SCOPE = 'platform'
export const DEFAULT_BATCH_SIZE = 1000
export const MAX_BATCH_SIZE = 5000
export const DEFAULT_RETENTION_DAYS = 2557 // seven years
export const MIN_RETENTION_DAYS = 365
/**
 * Records are picked in (occurred_at, id) order. A record whose transaction commits late can carry an occurred_at earlier than records already exported,
 * so each run looks back this far before the newest exported record. Anything older that is still unexported is a coverage gap the verifier reports.
 */
export const DEFAULT_HORIZON_HOURS = 24
export const horizonStart = (lastExportedAt: Date, horizonHours: number) => new Date(lastExportedAt.getTime() - horizonHours * 3_600_000)
export const ARCHIVE_ROOT = `compliance/v${COMPLIANCE_FORMAT_VERSION}/`

export interface ComplianceRecordRow {
  id: string
  tenantId: string | null
  category: string
  action: string
  entityType: string
  entityId: string
  actorType: string
  userId: string | null
  occurredAt: Date
  payloadText: string
  payloadSha256: string
  originCountry: string | null
  destinationCountry: string | null
  crossBorder: boolean | null
}

export interface BatchHeader {
  scope: string
  sequence: number
  previousSha256: string
  bodySha256: string
  recordCount: number
  firstOccurredAt: string
  lastOccurredAt: string
}

export interface BatchManifest extends BatchHeader {
  formatVersion: number
  batchSha256: string
  objectKey: string
  retainUntil: string
  sealedAt: string
}

/** One canonical NDJSON line. Key order is part of the format: never reorder. */
export function renderRecordLine(r: ComplianceRecordRow): string {
  return JSON.stringify({
    v: COMPLIANCE_FORMAT_VERSION, id: r.id, tenantId: r.tenantId, category: r.category, action: r.action, entityType: r.entityType, entityId: r.entityId,
    actorType: r.actorType, userId: r.userId, occurredAt: r.occurredAt.toISOString(), payloadSha256: r.payloadSha256, payloadText: r.payloadText,
    originCountry: r.originCountry, destinationCountry: r.destinationCountry, crossBorder: r.crossBorder,
  }) + '\n'
}

export function renderBatchBody(records: readonly ComplianceRecordRow[]): Buffer {
  return Buffer.from(records.map(renderRecordLine).join(''), 'utf8')
}

/** The chained hash of a batch. Any change to the body, the order, the scope or the predecessor changes it. */
export function batchSha256(h: BatchHeader): string {
  return sha256Hex([
    `fbeds-compliance-batch/v${COMPLIANCE_FORMAT_VERSION}`, `scope=${h.scope}`, `sequence=${h.sequence}`, `previous=${h.previousSha256}`,
    `body=${h.bodySha256}`, `records=${h.recordCount}`, `first=${h.firstOccurredAt}`, `last=${h.lastOccurredAt}`, '',
  ].join('\n'))
}

export function scopePrefix(scope: string): string { return `${ARCHIVE_ROOT}${scope}/` }
export function batchObjectKey(scope: string, sequence: number, hash: string): string {
  return `${scopePrefix(scope)}${String(sequence).padStart(10, '0')}-${hash.slice(0, 16)}.ndjson`
}
export const manifestKey = (objectKey: string) => objectKey.replace(/\.ndjson$/, '.manifest.json')

export function renderManifest(m: BatchManifest): Buffer {
  return Buffer.from(JSON.stringify({
    formatVersion: m.formatVersion, scope: m.scope, sequence: m.sequence, previousSha256: m.previousSha256, bodySha256: m.bodySha256, batchSha256: m.batchSha256,
    recordCount: m.recordCount, firstOccurredAt: m.firstOccurredAt, lastOccurredAt: m.lastOccurredAt, objectKey: m.objectKey, retainUntil: m.retainUntil, sealedAt: m.sealedAt,
  }, null, 2) + '\n', 'utf8')
}

export function assertScope(scope: string): void {
  if (scope !== PLATFORM_SCOPE && !/^[A-Za-z0-9_-]{1,64}$/.test(scope)) throw new Error('Invalid compliance scope')
}

export interface ComplianceExportOptions {
  archive: ComplianceArchive
  batchSize?: number
  retentionDays?: number
  horizonHours?: number
  /** Upper bound of batches sealed per scope per run, so one busy tenant cannot starve the others. */
  maxBatchesPerScope?: number
  now?: () => Date
}

export interface ScopeExportResult { scope: string; stored: Array<{ sequence: number; recordCount: number; batchSha256: string; objectKey: string }> }

type Tx = Prisma.TransactionClient

interface BatchRow {
  id: string; tenantId: string | null; scopeKey: string; sequence: number; formatVersion: number; recordCount: number; firstOccurredAt: Date; lastOccurredAt: Date
  bodySha256: string; previousSha256: string; batchSha256: string; objectKey: string; retainUntil: Date; sealedAt: Date
}

const RECORD_COLUMNS = `r."id", r."tenant_id" AS "tenantId", r."category"::text AS "category", r."action", r."entity_type" AS "entityType", r."entity_id" AS "entityId",
  r."actor_type"::text AS "actorType", r."user_id" AS "userId", r."occurred_at" AS "occurredAt", r."payload"::text AS "payloadText", r."payload_sha256" AS "payloadSha256",
  r."origin_country" AS "originCountry", r."destination_country" AS "destinationCountry", r."cross_border" AS "crossBorder"`

/** Opens a transaction that can see exactly one scope, and serializes exporters of that scope. */
export async function inScope<T>(db: PrismaClient, scope: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  assertScope(scope)
  return db.$transaction(async (tx) => {
    if (scope === PLATFORM_SCOPE) await tx.$executeRaw`SELECT set_config('app.compliance_scope', 'platform', true)`
    else await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${scope}, true)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fbeds:compliance:${scope}`}))`
    return work(tx)
  }, { timeout: 60_000, maxWait: 10_000 })
}

const tenantOf = (scope: string) => (scope === PLATFORM_SCOPE ? null : scope)

async function batchRecords(tx: Tx, batchId: string): Promise<ComplianceRecordRow[]> {
  return tx.$queryRawUnsafe<ComplianceRecordRow[]>(
    `SELECT ${RECORD_COLUMNS} FROM "ComplianceExportBatchRecord" m JOIN "ComplianceRecord" r ON r."id" = m."record_id" WHERE m."batch_id" = $1 ORDER BY m."position"`, batchId)
}

async function nextRecords(tx: Tx, scope: string, since: Date | null, limit: number): Promise<ComplianceRecordRow[]> {
  const tenantFilter = scope === PLATFORM_SCOPE ? 'r."tenant_id" IS NULL' : 'r."tenant_id" = $1'
  const params: unknown[] = scope === PLATFORM_SCOPE ? [] : [scope]
  // occurred_at is a UTC timestamp without time zone: compare with a UTC timestamp, never a timestamptz the session time zone would shift.
  const sinceFilter = since ? `AND r."occurred_at" >= $${params.push(since.toISOString().replace('Z', ''))}::timestamp` : ''
  params.push(limit)
  return tx.$queryRawUnsafe<ComplianceRecordRow[]>(
    `SELECT ${RECORD_COLUMNS} FROM "ComplianceRecord" r
      WHERE ${tenantFilter} ${sinceFilter}
        AND NOT EXISTS (SELECT 1 FROM "ComplianceExportBatchRecord" m WHERE m."record_id" = r."id")
      ORDER BY r."occurred_at", r."id" LIMIT $${params.length}`, ...params)
}

const BATCH_SELECT = { id: true, tenantId: true, scopeKey: true, sequence: true, formatVersion: true, recordCount: true, firstOccurredAt: true, lastOccurredAt: true, bodySha256: true, previousSha256: true, batchSha256: true, objectKey: true, retainUntil: true, sealedAt: true } as const

/** Phase 1: returns the oldest SEALED batch, or seals a new one, or null when the scope has nothing to do. */
async function sealOrResume(tx: Tx, scope: string, opts: Required<Omit<ComplianceExportOptions, 'archive'>>): Promise<{ batch: BatchRow; records: ComplianceRecordRow[] } | null> {
  const pending = await tx.complianceExportBatch.findFirst({ where: { scopeKey: scope, storageStatus: 'SEALED' }, orderBy: { sequence: 'asc' }, select: BATCH_SELECT })
  if (pending) return { batch: pending, records: await batchRecords(tx, pending.id) }
  const last = await tx.complianceExportBatch.findFirst({ where: { scopeKey: scope }, orderBy: { sequence: 'desc' }, select: { sequence: true, batchSha256: true, lastOccurredAt: true } })
  const since = last ? horizonStart(last.lastOccurredAt, opts.horizonHours) : null
  const records = await nextRecords(tx, scope, since, opts.batchSize)
  if (records.length === 0) return null
  const now = opts.now()
  const header: BatchHeader = {
    scope, sequence: (last?.sequence ?? 0) + 1, previousSha256: last?.batchSha256 ?? GENESIS_SHA256, bodySha256: sha256Hex(renderBatchBody(records)),
    recordCount: records.length, firstOccurredAt: records[0].occurredAt.toISOString(), lastOccurredAt: records[records.length - 1].occurredAt.toISOString(),
  }
  const hash = batchSha256(header)
  const batch = await tx.complianceExportBatch.create({
    data: {
      id: randomUUID(), tenantId: tenantOf(scope), scopeKey: scope, sequence: header.sequence, formatVersion: COMPLIANCE_FORMAT_VERSION, recordCount: header.recordCount,
      firstOccurredAt: records[0].occurredAt, lastOccurredAt: records[records.length - 1].occurredAt, bodySha256: header.bodySha256, previousSha256: header.previousSha256,
      batchSha256: hash, objectKey: batchObjectKey(scope, header.sequence, hash), retainUntil: new Date(now.getTime() + opts.retentionDays * 86_400_000), sealedAt: now,
    },
    select: BATCH_SELECT,
  })
  await tx.complianceExportBatchRecord.createMany({ data: records.map((r, i) => ({ batchId: batch.id, position: i + 1, tenantId: tenantOf(scope), recordId: r.id })) })
  return { batch, records }
}

export function manifestOf(batch: BatchRow): BatchManifest {
  return {
    formatVersion: batch.formatVersion, scope: batch.scopeKey, sequence: batch.sequence, previousSha256: batch.previousSha256, bodySha256: batch.bodySha256,
    batchSha256: batch.batchSha256, recordCount: batch.recordCount, firstOccurredAt: batch.firstOccurredAt.toISOString(), lastOccurredAt: batch.lastOccurredAt.toISOString(),
    objectKey: batch.objectKey, retainUntil: batch.retainUntil.toISOString(), sealedAt: batch.sealedAt.toISOString(),
  }
}

export class ComplianceIntegrityError extends Error {}

/** Phase 2: write-once upload of body and manifest, after re-checking every hash against the immutable records. */
async function store(archive: ComplianceArchive, batch: BatchRow, records: ComplianceRecordRow[]): Promise<string | null> {
  const body = renderBatchBody(records)
  const manifest = manifestOf(batch)
  if (records.length !== batch.recordCount || sha256Hex(body) !== batch.bodySha256 || batchSha256(manifest) !== batch.batchSha256) {
    throw new ComplianceIntegrityError(`Compliance batch ${batch.scopeKey}#${batch.sequence} no longer matches its sealed hash`)
  }
  for (const r of records) if (sha256Hex(r.payloadText) !== r.payloadSha256) throw new ComplianceIntegrityError(`Compliance record ${r.id} payload does not match its digest`)
  const retainUntil = batch.retainUntil
  const stored = await archive.put({ key: batch.objectKey, body, sha256: batch.bodySha256, contentType: 'application/x-ndjson', retainUntil })
  const manifestBody = renderManifest(manifest)
  await archive.put({ key: manifestKey(batch.objectKey), body: manifestBody, sha256: sha256Hex(manifestBody), contentType: 'application/json', retainUntil })
  return stored.versionId
}

function resolved(opts: ComplianceExportOptions): Required<Omit<ComplianceExportOptions, 'archive'>> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error(`Batch size must be 1-${MAX_BATCH_SIZE}`)
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) throw new Error(`Retention must be at least ${MIN_RETENTION_DAYS} days`)
  return { batchSize, retentionDays, horizonHours: opts.horizonHours ?? DEFAULT_HORIZON_HOURS, maxBatchesPerScope: opts.maxBatchesPerScope ?? 50, now: opts.now ?? (() => new Date()) }
}

export async function exportScope(db: PrismaClient, scope: string, opts: ComplianceExportOptions): Promise<ScopeExportResult> {
  const o = resolved(opts)
  const result: ScopeExportResult = { scope, stored: [] }
  for (let i = 0; i < o.maxBatchesPerScope; i++) {
    const next = await inScope(db, scope, (tx) => sealOrResume(tx, scope, o))
    if (!next) break
    const versionId = await store(opts.archive, next.batch, next.records)
    await inScope(db, scope, (tx) => tx.complianceExportBatch.updateMany({ where: { id: next.batch.id, storageStatus: 'SEALED' }, data: { storageStatus: 'STORED', storedAt: o.now(), objectVersionId: versionId } }))
    result.stored.push({ sequence: next.batch.sequence, recordCount: next.batch.recordCount, batchSha256: next.batch.batchSha256, objectKey: next.batch.objectKey })
  }
  return result
}

/** Scopes with work, from the SECURITY DEFINER function (ids only; no cross-tenant table read). */
export async function dueScopes(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ scope: string }>>`SELECT s AS scope FROM "fbeds_compliance_due_scopes"() s ORDER BY 1`
  return rows.map((r) => r.scope)
}

/** Integrity and archive conflicts carry only ids and keys; any other error is reduced to its class and code, never its message (it may quote SQL or a URL). */
function describeFailure(error: unknown): string {
  if (error instanceof ComplianceIntegrityError || error instanceof ComplianceArchiveConflict) return error.message
  if (!(error instanceof Error)) return 'Error'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? `${error.name} (${code})` : error.name
}

/** Every scope with a record or a batch, for the verifier. */
export async function knownScopes(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ scope: string }>>`SELECT s AS scope FROM "fbeds_compliance_known_scopes"() s ORDER BY 1`
  return rows.map((r) => r.scope)
}

/**
 * One exporter run over every due scope. A failing scope does not stop the others, but it is never hidden: it is returned in `failed`
 * and the CLI exits non-zero (CLAUDE.md invariant 5).
 */
export async function exportDue(db: PrismaClient, opts: ComplianceExportOptions): Promise<{ exported: ScopeExportResult[]; failed: Array<{ scope: string; error: string }> }> {
  await opts.archive.assertReady()
  const exported: ScopeExportResult[] = []
  const failed: Array<{ scope: string; error: string }> = []
  for (const scope of await dueScopes(db)) {
    try { exported.push(await exportScope(db, scope, opts)) } catch (error) {
      failed.push({ scope, error: describeFailure(error) })
    }
  }
  return { exported, failed }
}
