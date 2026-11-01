import type { IngestFeedKind } from './ingest-profile'

/** One unit of ingestion work. Tenant, supplier and connector come from server-side configuration, never from a feed. */
export interface FeedJob {
  tenantId: string
  supplierId: string
  connectorId: string
  profileKey: string
  kind: IngestFeedKind
}

/** A fetched or pushed document. `deliveryId` is stable across retries of the same delivery and changes when the source publishes a new one. */
export interface FeedDelivery {
  deliveryId: string
  body: string | Uint8Array
  receivedAt: Date
  /** The source's own feed time, or null. Never fabricated. */
  sourceUpdatedAt: Date | null
}

export interface FeedJobSource { dueJobs(): Promise<FeedJob[]> }
/** Fetching is transport work (endpoint policy, secrets, retries: ADR 0060) and belongs to the source's own connector, not to the ingestion service. */
export interface FeedFetcher { fetch(job: FeedJob): Promise<FeedDelivery> }

export const SUPPLIER_FEED_JOB_SOURCE = Symbol('SUPPLIER_FEED_JOB_SOURCE')
export const SUPPLIER_FEED_FETCHER = Symbol('SUPPLIER_FEED_FETCHER')

/** The defaults: no source, no jobs. Nothing is fetched until a real source and profile are registered. */
export const NO_FEED_JOBS: FeedJobSource = { dueJobs: async () => [] }
export const NO_FEED_FETCHER: FeedFetcher = { fetch: async () => { throw new Error('No feed fetcher is registered') } }
