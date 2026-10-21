import { NO_FEED_FETCHER, NO_FEED_JOBS } from './feed-ports'
import { IngestProfileRegistry } from './ingest-profile'
import { SupplierIngestWorker } from './supplier-ingest.worker'

const profile = { key: 'synthetic-json', format: 'json' as const, freshnessMs: 3_600_000, specs: { RATES: { recordPath: 'a[]', fields: {} } } }
const configured = { configured: () => true } as never
const registry = (n = 1) => { const r = new IngestProfileRegistry(); if (n) r.register(profile); return r }
const real = { dueJobs: async () => [] }
const fetcher = { fetch: async () => { throw new Error('x') } }
const on = { SUPPLIER_INGEST_ENABLED: 'true', SUPPLIER_INGEST_WORKER_ENABLED: 'true' }

describe('supplier ingestion worker startup', () => {
  const make = (db: unknown, profiles: IngestProfileRegistry, jobs: never, fetch: never, env: Record<string, string | undefined>) => new SupplierIngestWorker(db as never, {} as never, profiles, jobs, fetch, env)

  it('does nothing unless both flags are set', () => {
    for (const env of [{}, { SUPPLIER_INGEST_ENABLED: 'true' }, { SUPPLIER_INGEST_WORKER_ENABLED: 'true' }]) expect(() => make({ configured: () => false }, registry(0), NO_FEED_JOBS as never, NO_FEED_FETCHER as never, env).onModuleInit()).not.toThrow()
  })

  it('refuses to start enabled without its own database role, a profile, a job source or a fetcher, or with a too-short interval', () => {
    expect(() => make({ configured: () => false }, registry(), real as never, fetcher as never, on).onModuleInit()).toThrow(/SUPPLIER_INGEST_DATABASE_URL/)
    expect(() => make(configured, registry(0), real as never, fetcher as never, on).onModuleInit()).toThrow(/no ingest profile/)
    expect(() => make(configured, registry(), NO_FEED_JOBS as never, fetcher as never, on).onModuleInit()).toThrow(/no ingest profile/)
    expect(() => make(configured, registry(), real as never, NO_FEED_FETCHER as never, on).onModuleInit()).toThrow(/no ingest profile/)
    expect(() => make(configured, registry(), real as never, fetcher as never, { ...on, SUPPLIER_INGEST_WORKER_INTERVAL_MS: '100' }).onModuleInit()).toThrow(/INTERVAL/)
  })

  it('starts and stops cleanly when fully configured', () => {
    const w = make(configured, registry(), real as never, fetcher as never, on)
    expect(() => w.onModuleInit()).not.toThrow()
    w.onModuleDestroy()
  })
})

describe('ingest profile registry', () => {
  it('rejects duplicate keys, bad keys, empty specs and out-of-range freshness', () => {
    const r = registry()
    expect(() => r.register(profile)).toThrow(/already registered/)
    expect(() => r.register({ ...profile, key: 'Bad Key' })).toThrow(/key/)
    expect(() => r.register({ ...profile, key: 'other-one', specs: {} })).toThrow(/spec/)
    expect(() => r.register({ ...profile, key: 'other-two', freshnessMs: 10 })).toThrow(/freshnessMs/)
    expect(() => r.register({ ...profile, key: 'other-three', freshnessMs: 8 * 24 * 3_600_000 })).toThrow(/freshnessMs/)
    expect(r.size()).toBe(1)
  })
})
