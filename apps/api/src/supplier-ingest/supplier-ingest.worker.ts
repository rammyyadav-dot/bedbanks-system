import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { NO_FEED_FETCHER, NO_FEED_JOBS, SUPPLIER_FEED_FETCHER, SUPPLIER_FEED_JOB_SOURCE, type FeedFetcher, type FeedJobSource } from './feed-ports'
import { IngestProfileRegistry } from './ingest-profile'
import { SupplierIngestDatabase } from './supplier-ingest.database'
import { SupplierIngestService } from './supplier-ingest.service'

const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 60_000

type Env = Record<string, string | undefined>

/**
 * The background worker of supplier ingestion (ADR 0080). Disabled unless SUPPLIER_INGEST_ENABLED=true and SUPPLIER_INGEST_WORKER_ENABLED=true.
 *
 * It asks the registered `FeedJobSource` which feeds are due, has the `FeedFetcher` obtain each delivery, and hands it to `SupplierIngestService`. The jobs, the fetcher and the
 * profiles are all registered by deployment configuration; none ships, so enabling the worker without them is a misconfiguration and the API refuses to start. A pass never overlaps
 * itself in one process, and is harmless across processes: a delivery's run is unique per idempotency key and serialized by an advisory lock. A failing job is logged by code and
 * does not stop the others; nothing from a payload is logged.
 */
@Injectable()
export class SupplierIngestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupplierIngestWorker.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly db: SupplierIngestDatabase,
    private readonly service: SupplierIngestService,
    private readonly profiles: IngestProfileRegistry,
    @Optional() @Inject(SUPPLIER_FEED_JOB_SOURCE) private readonly jobs: FeedJobSource = NO_FEED_JOBS,
    @Optional() @Inject(SUPPLIER_FEED_FETCHER) private readonly fetcher: FeedFetcher = NO_FEED_FETCHER,
    @Optional() private readonly env: Env = process.env,
  ) {}

  private enabled = () => this.env.SUPPLIER_INGEST_WORKER_ENABLED === 'true' && this.env.SUPPLIER_INGEST_ENABLED === 'true'

  onModuleInit(): void {
    if (!this.enabled()) return
    if (!this.db.configured()) throw new Error('SUPPLIER_INGEST_DATABASE_URL must be set (and differ from DATABASE_URL) when the supplier ingestion worker is enabled')
    if (this.profiles.size() === 0 || this.jobs === NO_FEED_JOBS || this.fetcher === NO_FEED_FETCHER) throw new Error('The supplier ingestion worker is enabled but no ingest profile, feed job source or feed fetcher is registered')
    const interval = Number(this.env.SUPPLIER_INGEST_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`SUPPLIER_INGEST_WORKER_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Supplier ingestion worker enabled every ${interval}ms`)
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over due jobs; never overlaps itself. Returns deliveries that applied observations. */
  async runOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let applied = 0
    let failed = 0
    try {
      for (const job of await this.jobs.dueJobs()) {
        try {
          const summary = await this.service.ingest(job, await this.fetcher.fetch(job))
          if (summary.applied) applied++
          else if (!summary.replayed) failed++
        } catch (error) {
          failed++
          this.logger.error(`Supplier ingestion job ${job.kind} failed for connector ${job.connectorId}: ${error instanceof Error ? (error as { code?: string }).code ?? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Supplier ingestion worker could not list due jobs: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally { this.running = false }
    if (applied > 0 || failed > 0) this.logger.log(`Supplier ingestion pass: applied=${applied} notApplied=${failed}`)
    return applied
  }
}
