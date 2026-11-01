import { Module } from '@nestjs/common'
import { NO_FEED_FETCHER, NO_FEED_JOBS, SUPPLIER_FEED_FETCHER, SUPPLIER_FEED_JOB_SOURCE } from './feed-ports'
import { IngestProfileRegistry } from './ingest-profile'
import { SupplierIngestDatabase } from './supplier-ingest.database'
import { SupplierIngestService } from './supplier-ingest.service'
import { SupplierIngestWorker } from './supplier-ingest.worker'

/**
 * Supplier ingestion (ADR 0080). Off unless its flags and its own database role are configured. The module ships with an empty profile registry, no job source and no fetcher, so
 * nothing is fetched until a deployment registers real ones; the worker refuses to start enabled without them.
 */
@Module({
  providers: [
    SupplierIngestDatabase,
    IngestProfileRegistry,
    SupplierIngestService,
    { provide: SUPPLIER_FEED_JOB_SOURCE, useValue: NO_FEED_JOBS },
    { provide: SUPPLIER_FEED_FETCHER, useValue: NO_FEED_FETCHER },
    SupplierIngestWorker,
  ],
  exports: [SupplierIngestService, IngestProfileRegistry],
})
export class SupplierIngestModule {}
