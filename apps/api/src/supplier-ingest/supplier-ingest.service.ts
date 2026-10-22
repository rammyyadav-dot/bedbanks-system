import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import {
  IngestShapeError, extractJsonRecords, extractXmlRecords, normalizeAllotments, normalizeCancellationPolicies, normalizeRates,
  type IngestResult, type IngestStatus, type RawRecord,
} from '@bedbanks/connectors-core'
import { IngestProfileRegistry, type IngestFeedKind, type IngestProfile } from './ingest-profile'
import type { FeedDelivery, FeedJob } from './feed-ports'
import { persistAllotments, persistCancellationPolicies, persistRates, type PersistOutcome, type PersistScope } from './ingest-persistence'
import { SupplierIngestDatabase } from './supplier-ingest.database'

export type IngestJobRefusal = 'PROFILE_UNKNOWN' | 'KIND_UNSUPPORTED'
export class IngestJobRefused extends Error {
  constructor(readonly code: IngestJobRefusal) { super(`Ingest job refused (${code})`); this.name = 'IngestJobRefused' }
}

export interface IngestSummary extends PersistOutcome { kind: IngestFeedKind; rejected: number; extracted: number }

/**
 * Runs one delivery through extract, normalize and persist (ADR 0080). Everything provider-specific is the profile; everything after it is shared and fails closed.
 *  - A document that cannot be read (wrong shape, DOCTYPE, bad UTF-8, oversized) is recorded as a FAILED run, evidence that the delivery arrived and was refused.
 *  - Only a COMPLETE result applies observations (ADR 0078). PARTIAL and FAILED are recorded and change nothing.
 *  - The idempotency key derives from the profile, kind and delivery id, so a retried delivery replays and a republished one under the same id with different content is refused.
 *  - Payloads are never logged. Only counts and codes leave this class.
 */
@Injectable()
export class SupplierIngestService {
  private readonly logger = new Logger(SupplierIngestService.name)

  constructor(private readonly db: SupplierIngestDatabase, private readonly profiles: IngestProfileRegistry) {}

  async ingest(job: FeedJob, delivery: FeedDelivery): Promise<IngestSummary> {
    const profile = this.profiles.get(job.profileKey)
    if (!profile) throw new IngestJobRefused('PROFILE_UNKNOWN')
    if (!profile.specs[job.kind]) throw new IngestJobRefused('KIND_UNSUPPORTED')

    const scope: PersistScope = {
      tenantId: job.tenantId, supplierId: job.supplierId, connectorId: job.connectorId, actorUserId: null,
      idempotencyKey: createHash('sha256').update(`${profile.key}|${job.kind}|${delivery.deliveryId}`).digest('hex'),
      receivedAt: delivery.receivedAt, sourceUpdatedAt: delivery.sourceUpdatedAt, freshUntil: new Date(delivery.receivedAt.getTime() + profile.freshnessMs),
    }
    const summarize = (outcome: PersistOutcome, result: IngestResult<unknown>): IngestSummary => ({ ...outcome, kind: job.kind, rejected: result.rejected.length, extracted: result.extracted })
    const run = <T>(result: IngestResult<T>, persist: (tx: Parameters<Parameters<SupplierIngestDatabase['withTenant']>[1]>[0], s: PersistScope, r: IngestResult<T>) => Promise<PersistOutcome>) =>
      this.db.withTenant(job.tenantId, (tx) => persist(tx, scope, result)).then((o) => summarize(o, result))

    const rows = this.extract(profile, job.kind, delivery)
    const options = { today: delivery.receivedAt.toISOString().slice(0, 10), horizonDays: profile.horizonDays, maxRejectBasisPoints: profile.maxRejectBasisPoints }
    let summary: IngestSummary
    if (rows === null) {
      const failed: IngestResult<never> = { accepted: [], rejected: [], extracted: 0, status: 'FAILED' }
      // The persisted kind decides which writer runs; a FAILED result writes no observation whichever it is.
      summary = job.kind === 'RATES' ? await run(failed as IngestResult<never>, persistRates) : job.kind === 'ALLOTMENTS' ? await run(failed as IngestResult<never>, persistAllotments) : await run(failed as IngestResult<never>, persistCancellationPolicies)
    } else if (job.kind === 'RATES') summary = await run(normalizeRates(rows, options), persistRates)
    else if (job.kind === 'ALLOTMENTS') summary = await run(normalizeAllotments(rows, options), persistAllotments)
    else summary = await run(normalizeCancellationPolicies(rows, { ...options, ...profile.cancellation }), persistCancellationPolicies)

    this.logger.log(`Ingest ${job.kind} ${summary.status}${summary.replayed ? ' (replayed)' : ''}: extracted=${summary.extracted} rejected=${summary.rejected} written=${summary.written} superseded=${summary.superseded}`)
    return summary
  }

  /** null means the document could not be read; the caller records a FAILED run. */
  private extract(profile: IngestProfile, kind: IngestFeedKind, delivery: FeedDelivery): RawRecord[] | null {
    const spec = profile.specs[kind]
    if (!spec) return null
    try { return profile.format === 'xml' ? extractXmlRecords(delivery.body, spec) : extractJsonRecords(typeof delivery.body === 'string' ? delivery.body : Buffer.from(delivery.body).toString('utf8'), spec) } catch (error) {
      if (error instanceof IngestShapeError) return null
      throw error
    }
  }
}

export type { IngestStatus }
