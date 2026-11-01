import type { PrismaClient } from '@prisma/client'
import { sha256Hex, type ComplianceArchive } from './compliance-archive'
import {
  COMPLIANCE_FORMAT_VERSION, DEFAULT_HORIZON_HOURS, GENESIS_SHA256, PLATFORM_SCOPE, batchObjectKey, batchSha256, horizonStart, inScope, scopePrefix, type BatchManifest,
} from './compliance-export'

/**
 * Independent verification of the compliance archive (ADR 0067).
 *
 * `verifyArchivedBatch` and `verifyArchiveChain` need only the archive objects: an external auditor can run the same checks with any SHA-256 tool.
 * `verifyScope` also compares the archive with the database and reports records that were never exported (a capture/export coverage gap).
 * Reports carry ids, sequences and keys only, never payloads.
 */
export interface BatchCheck { sequence: number; objectKey: string; recordCount: number; failures: string[] }

const HEX64 = /^[0-9a-f]{64}$/

export function verifyArchivedBatch(manifest: BatchManifest, body: Buffer | null, expectedPrevious: string, expectedSequence: number): BatchCheck {
  const failures: string[] = []
  const tag = `${manifest.scope}#${manifest.sequence}`
  if (manifest.formatVersion !== COMPLIANCE_FORMAT_VERSION) failures.push(`${tag}: unknown format version ${manifest.formatVersion}`)
  if (manifest.sequence !== expectedSequence) failures.push(`${tag}: expected sequence ${expectedSequence} (a batch is missing or duplicated)`)
  if (manifest.previousSha256 !== expectedPrevious) failures.push(`${tag}: previous hash does not link to the preceding batch`)
  if (!HEX64.test(manifest.batchSha256) || batchSha256(manifest) !== manifest.batchSha256) failures.push(`${tag}: batch hash does not match its header`)
  if (manifest.objectKey !== batchObjectKey(manifest.scope, manifest.sequence, manifest.batchSha256)) failures.push(`${tag}: object key does not match the batch`)
  if (!body) return { sequence: manifest.sequence, objectKey: manifest.objectKey, recordCount: 0, failures: [...failures, `${tag}: batch body is missing`] }
  if (sha256Hex(body) !== manifest.bodySha256) failures.push(`${tag}: body hash does not match the manifest`)
  const lines = body.toString('utf8').split('\n')
  if (lines.pop() !== '') failures.push(`${tag}: body does not end with a newline`)
  if (lines.length !== manifest.recordCount) failures.push(`${tag}: ${lines.length} records, manifest says ${manifest.recordCount}`)
  const ids = new Set<string>()
  let previousAt = ''
  lines.forEach((line, index) => {
    let record: { id?: unknown; tenantId?: unknown; occurredAt?: unknown; payloadText?: unknown; payloadSha256?: unknown }
    try { record = JSON.parse(line) } catch { failures.push(`${tag}: line ${index + 1} is not JSON`); return }
    const id = String(record.id)
    if (ids.has(id)) failures.push(`${tag}: record ${id} appears twice`)
    ids.add(id)
    const expectedTenant = manifest.scope === PLATFORM_SCOPE ? null : manifest.scope
    if (record.tenantId !== expectedTenant) failures.push(`${tag}: record ${id} belongs to another scope`)
    if (typeof record.payloadText !== 'string' || sha256Hex(record.payloadText) !== record.payloadSha256) failures.push(`${tag}: record ${id} payload does not match its digest`)
    const at = String(record.occurredAt)
    if (at < previousAt) failures.push(`${tag}: record ${id} is out of order`)
    previousAt = at
    if (index === 0 && at !== manifest.firstOccurredAt) failures.push(`${tag}: first record time does not match the manifest`)
    if (index === lines.length - 1 && at !== manifest.lastOccurredAt) failures.push(`${tag}: last record time does not match the manifest`)
  })
  return { sequence: manifest.sequence, objectKey: manifest.objectKey, recordCount: lines.length, failures }
}

/** `hashes`: the archived batch hash at each sequence, for checking signed checkpoints against the chain. */
export interface ChainReport { scope: string; batches: number; records: number; headSha256: string; hashes: Map<number, string>; failures: string[] }

/** Walks one scope's chain in the archive, from the genesis batch to the head. */
export async function verifyArchiveChain(archive: ComplianceArchive, scope: string): Promise<ChainReport> {
  const manifests: BatchManifest[] = []
  const failures: string[] = []
  for (const key of (await archive.list(scopePrefix(scope))).filter((k) => k.endsWith('.manifest.json'))) {
    const raw = await archive.get(key)
    try { manifests.push(JSON.parse(raw?.toString('utf8') ?? '')) } catch { failures.push(`${key}: manifest is not JSON`) }
  }
  manifests.sort((a, b) => a.sequence - b.sequence)
  let previous = GENESIS_SHA256
  let records = 0
  const hashes = new Map<number, string>()
  for (const [index, manifest] of manifests.entries()) {
    hashes.set(manifest.sequence, manifest.batchSha256)
    if (manifest.scope !== scope) failures.push(`${scope}#${manifest.sequence}: manifest names scope ${manifest.scope}`)
    const check = verifyArchivedBatch(manifest, await archive.get(manifest.objectKey), previous, index + 1)
    failures.push(...check.failures)
    records += check.recordCount
    previous = manifest.batchSha256
  }
  return { scope, batches: manifests.length, records, headSha256: previous, hashes, failures }
}

export interface ScopeReport extends ChainReport { databaseBatches: number; sealedNotStored: number; skippedBehindChain: number; overdue: number }

/**
 * Archive chain plus database cross-check for one scope, run as the compliance role. Every STORED batch must be in the archive with the same hash,
 * the archive must not hold a batch the database does not know, no record may be left behind the exported chain (older than its horizon), and no
 * record may wait longer than `maxLagHours` (a stalled exporter).
 */
export async function verifyScope(db: PrismaClient, archive: ComplianceArchive, scope: string, opts: { horizonHours?: number; maxLagHours?: number; now?: () => Date } = {}): Promise<ScopeReport> {
  const chain = await verifyArchiveChain(archive, scope)
  const tenantId = scope === PLATFORM_SCOPE ? null : scope
  const overdueBefore = new Date((opts.now ?? (() => new Date()))().getTime() - (opts.maxLagHours ?? DEFAULT_HORIZON_HOURS) * 3_600_000)
  const { batches, skipped, overdue } = await inScope(db, scope, async (tx) => {
    const batches = await tx.complianceExportBatch.findMany({ where: { scopeKey: scope }, orderBy: { sequence: 'asc' }, select: { sequence: true, batchSha256: true, storageStatus: true, lastOccurredAt: true } })
    const head = batches[batches.length - 1]
    const skipped = head ? await tx.complianceRecord.count({ where: { tenantId, occurredAt: { lt: horizonStart(head.lastOccurredAt, opts.horizonHours ?? DEFAULT_HORIZON_HOURS) }, exports: { is: null } } }) : 0
    const overdue = await tx.complianceRecord.count({ where: { tenantId, occurredAt: { lt: overdueBefore }, exports: { is: null } } })
    return { batches, skipped, overdue }
  })
  const failures = [...chain.failures]
  const archived = new Map<number, string>()
  for (const key of (await archive.list(scopePrefix(scope))).filter((k) => k.endsWith('.manifest.json'))) {
    try {
      const parsed = JSON.parse((await archive.get(key))?.toString('utf8') ?? '') as Partial<BatchManifest>
      if (typeof parsed.sequence === 'number' && typeof parsed.batchSha256 === 'string') archived.set(parsed.sequence, parsed.batchSha256)
    } catch { /* already reported by the chain walk */ }
  }
  for (const batch of batches) {
    const inArchive = archived.get(batch.sequence)
    if (batch.storageStatus === 'STORED' && inArchive !== batch.batchSha256) failures.push(`${scope}#${batch.sequence}: stored batch is missing from the archive or differs`)
    if (inArchive !== undefined && inArchive !== batch.batchSha256) failures.push(`${scope}#${batch.sequence}: archive and database disagree on the batch hash`)
    archived.delete(batch.sequence)
  }
  for (const sequence of archived.keys()) failures.push(`${scope}#${sequence}: archived batch is unknown to the database`)
  if (skipped > 0) failures.push(`${scope}: ${skipped} compliance record(s) fell behind the exported chain and will not be exported`)
  if (overdue > 0) failures.push(`${scope}: ${overdue} compliance record(s) have waited longer than the allowed export lag`)
  return { ...chain, failures, databaseBatches: batches.length, sealedNotStored: batches.filter((b) => b.storageStatus === 'SEALED').length, skippedBehindChain: skipped, overdue }
}
